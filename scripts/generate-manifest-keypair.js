#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.join(__dirname, '..');
const securityDir = path.join(projectRoot, 'security');
const privatePath = path.join(securityDir, 'manifest-private-key.pem');
const publicPath = path.join(securityDir, 'manifest-public-key.pem');

fs.mkdirSync(securityDir, { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8');
fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), 'utf8');

console.log('[+] Generated manifest signing keypair');
console.log(`    Public:  ${publicPath}`);
console.log(`    Private: ${privatePath}`);
