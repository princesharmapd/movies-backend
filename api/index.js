import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import path from 'path';
import yauzl from 'yauzl';
import { Readable } from 'stream';
import NodeCache from "node-cache";
import axios from "axios";

const app = express();
const client = new WebTorrent({ maxConns: 20 }); // Limit peers for better performance

app.use(cors());
app.use(express.json());

const cache = new NodeCache({ stdTTL: 86400 }); // Cache for 24 hours
const API_URL = "https://torrent-fast-api.onrender.com/api/v1";

// Fetch and cache movies with retries and timeouts
const fetchMovies = async (endpoint, cacheKey) => {
  const cachedMovies = cache.get(cacheKey);
  if (cachedMovies) return cachedMovies;

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`Fetching: ${endpoint} (Attempt: ${attempt + 1})`);
      const response = await axios.get(`${API_URL}/${endpoint}?site=yts&limit=50`, { timeout: 15000 });
      const movies = response.data.data.filter(movie => movie.name && movie.poster && movie.rating);
      cache.set(cacheKey, movies);
      return movies;
    } catch (error) {
      console.error(`Error fetching ${cacheKey} (Attempt ${attempt + 1}):`, error.message);
    }
  }
  return cachedMovies || [];
};

// Background job to refresh cache every 24 hours
const refreshCache = async () => {
  console.log("Refreshing movie cache...");
  await fetchMovies("trending", "trending_movies");
  await fetchMovies("recent", "recent_movies");
};
setInterval(refreshCache, 24 * 60 * 60 * 1000);

// API Endpoints
app.get("/movies/trending", async (req, res) => {
  const movies = cache.get("trending_movies") || (await fetchMovies("trending", "trending_movies"));
  res.json(movies);
});

app.get("/movies/recent", async (req, res) => {
  const movies = cache.get("recent_movies") || (await fetchMovies("recent", "recent_movies"));
  res.json(movies);
});

app.get("/movies/search", async (req, res) => {
  const { query, page = 1 } = req.query;
  if (!query) return res.status(400).json({ error: "Query is required!" });

  const cacheKey = `search_${query}_${page}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${API_URL}/search?site=yts&query=${query}&limit=10&page=${page}`, { timeout: 15000 });
    const movies = response.data.data.filter(movie => movie.name && movie.poster && movie.rating);
    cache.set(cacheKey, movies, 86400);
    res.json(movies);
  } catch (error) {
    console.error("Search error:", error.message);
    res.status(500).json({ error: "Error fetching search results." });
  }
});

// Helper to extract infoHash from magnet link
function extractInfoHash(magnet) {
  const match = magnet.match(/urn:btih:([a-fA-F0-9]{40})/);
  return match ? match[1].toLowerCase() : null;
}

// Endpoint to list files in the torrent
app.get('/list-files/:magnet', (req, res) => {
  const magnet = req.params.magnet;
  const infoHash = extractInfoHash(magnet);

  if (!infoHash) return res.status(400).send('Invalid magnet link');

  const existingTorrent = client.torrents.find((torrent) => torrent.infoHash === infoHash);

  if (existingTorrent) {
    return getFiles(existingTorrent).then((files) => res.json(files));
  }

  client.add(magnet, (torrent) => {
    getFiles(torrent).then((files) => res.json(files));
  });
});

// Helper to get video and image files
async function getFiles(torrent) {
  return torrent.files.map(file => ({
    name: file.name,
    length: file.length,
    path: file.path,
    type: getFileType(file.name),
  })).filter(file => file.type === 'video' || file.type === 'image');
}

// Determine file type
function getFileType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (['.mp4', '.mkv', '.avi'].includes(ext)) return 'video';
  if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) return 'image';
  return 'other';
}

// Endpoint to stream a specific video file
app.get('/stream/:magnet/:filename', (req, res) => {
  const { magnet, filename } = req.params;
  const infoHash = extractInfoHash(magnet);

  if (!infoHash) return res.status(400).send('Invalid magnet link');

  const torrent = client.torrents.find((t) => t.infoHash === infoHash);
  if (!torrent) return res.status(404).send('Torrent not found');

  const file = torrent.files.find((f) => f.name === filename);
  if (!file) return res.status(404).send('File not found');

  const range = req.headers.range;
  if (!range) return res.status(400).send('Requires Range header');

  const [start, end] = range.replace(/bytes=/, '').split('-').map(Number);
  const chunkEnd = end || Math.min(start + 10 ** 6, file.length - 1);

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${chunkEnd}/${file.length}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkEnd - start + 1,
    'Content-Type': 'video/mp4',
  });

  file.createReadStream({ start, end: chunkEnd }).pipe(res);
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});