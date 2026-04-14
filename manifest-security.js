const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRUSTED_UPDATE_ORIGIN = String(process.env.TRUSTED_UPDATE_ORIGIN || '').trim().replace(/\/+$/, '');
const ALLOWED_DISCORD_HOSTS = new Set(['discord.gg', 'discord.com', 'www.discord.com']);
const MAX_FEED_SERVERS = 64;
const MAX_FEED_MEDIA_ITEMS = 256;
const EMBEDDED_MANIFEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApndgUaT8QMUtMRVbgU591Yjm8gYRfYUMfLCI8vg6Ba0=
-----END PUBLIC KEY-----
`;

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function stripSignature(manifest) {
  if (!manifest || typeof manifest !== 'object') return manifest;
  const clone = { ...manifest };
  delete clone.signature;
  return clone;
}

function canonicalizeManifest(manifest) {
  return stableStringify(stripSignature(manifest));
}

function projectRoot() {
  return __dirname;
}

function defaultPrivateKeyPath() {
  return path.join(projectRoot(), 'security', 'manifest-private-key.pem');
}

function defaultPublicKeyPath() {
  return path.join(projectRoot(), 'security', 'manifest-public-key.pem');
}

function loadManifestPrivateKey() {
  if (process.env.MANIFEST_SIGNING_PRIVATE_KEY) {
    return process.env.MANIFEST_SIGNING_PRIVATE_KEY;
  }

  const configuredPath = process.env.MANIFEST_SIGNING_PRIVATE_KEY_PATH || defaultPrivateKeyPath();
  if (fs.existsSync(configuredPath)) {
    return fs.readFileSync(configuredPath, 'utf8');
  }

  throw new Error('Manifest signing private key not found. Set MANIFEST_SIGNING_PRIVATE_KEY or create security/manifest-private-key.pem.');
}

function loadManifestPublicKey() {
  const configuredPath = process.env.MANIFEST_SIGNING_PUBLIC_KEY_PATH || defaultPublicKeyPath();
  if (fs.existsSync(configuredPath)) {
    return fs.readFileSync(configuredPath, 'utf8');
  }
  return EMBEDDED_MANIFEST_PUBLIC_KEY;
}

function signManifest(manifest) {
  const privateKey = loadManifestPrivateKey();
  const payload = canonicalizeManifest(manifest);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
  return { ...stripSignature(manifest), signature };
}

function verifyManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.signature) return false;
  const payload = canonicalizeManifest(manifest);
  try {
    return crypto.verify(
      null,
      Buffer.from(payload, 'utf8'),
      loadManifestPublicKey(),
      Buffer.from(String(manifest.signature), 'base64'),
    );
  } catch {
    return false;
  }
}

function parseUrl(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function isTrustedContentUrl(input, pathPrefix = '/') {
  if (!TRUSTED_UPDATE_ORIGIN) return false;
  const parsed = parseUrl(input);
  if (!parsed) return false;
  if (parsed.protocol !== 'https:') return false;
  if (parsed.origin !== TRUSTED_UPDATE_ORIGIN) return false;
  return parsed.pathname.startsWith(pathPrefix);
}

function isAllowedDiscordUrl(input) {
  const parsed = parseUrl(input);
  if (!parsed) return false;
  if (parsed.protocol !== 'https:') return false;
  return ALLOWED_DISCORD_HOSTS.has(parsed.hostname);
}

module.exports = {
  TRUSTED_UPDATE_ORIGIN,
  MAX_FEED_MEDIA_ITEMS,
  MAX_FEED_SERVERS,
  canonicalizeManifest,
  isAllowedDiscordUrl,
  isTrustedContentUrl,
  signManifest,
  stripSignature,
  verifyManifest,
};
