#!/usr/bin/env node
// Seals the house sync settings (data repo + access token) with a password into
// web/house-key.json. An APK built afterwards carries the file; on first start
// it asks for the password and turns sync on by itself.
//
//   node tools/make-house-key.mjs            (asks for everything, input hidden)
//   node tools/make-house-key.mjs --offline  (skip the GitHub check)
//
// The file is gitignored on purpose: send that APK privately, never publish it.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const HouseKey = require('../web/house-key.js');
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'house-key.json');

function prompt(question, { hidden = false, fallback = '' } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = text => { if (text.startsWith(question)) process.stdout.write(question); };
    rl.question(question, answer => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim() || fallback);
    });
  });
}

async function checkRepo(repo, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GitHub says ${res.status}: the token cannot see ${repo}`);
  if ((await res.json()).private !== true) throw new Error(`${repo} is public; the app only syncs to a private repo`);
}

const repo = await prompt('Data repo [Hafij-DEU/house-cost-data]: ', { fallback: 'Hafij-DEU/house-cost-data' });
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Repo must look like owner/name');
const token = await prompt('Access token (hidden): ', { hidden: true });
if (!token) throw new Error('No token given');
if (!process.argv.includes('--offline')) {
  await checkRepo(repo, token);
  console.log(`Token works and ${repo} is private.`);
}
const password = await prompt('House password (hidden): ', { hidden: true });
if (!password) throw new Error('No password given');
if (await prompt('Password again (hidden): ', { hidden: true }) !== password) throw new Error('Passwords differ');
if (password.length < 10) {
  console.log('Note: a short password can be guessed quickly by anyone who gets the APK file. Share the APK only privately.');
}

const sealed = await HouseKey.seal({ repo, token }, password);
const back = await HouseKey.open(sealed, password);
if (!back || back.token !== token || back.repo !== repo) throw new Error('Self-check failed');
writeFileSync(OUT, JSON.stringify(sealed, null, 1) + '\n', { mode: 0o600 });
console.log(`Wrote ${OUT}. Build the APK now; the file goes inside it.`);
