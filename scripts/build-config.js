#!/usr/bin/env node
// Vercel build step: generate public/config.js from environment variables.
// This keeps secrets out of git but makes them available to the browser.

const fs = require('fs');
const path = require('path');

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!MAPBOX_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[build-config] Warning: missing env vars');
    console.warn('  MAPBOX_TOKEN:', MAPBOX_TOKEN ? 'set' : 'MISSING');
    console.warn('  SUPABASE_URL:', SUPABASE_URL ? 'set' : 'MISSING');
    console.warn('  SUPABASE_ANON_KEY:', SUPABASE_ANON_KEY ? 'set' : 'MISSING');
}

// JSON.stringify escapes strings safely
const content = `// Auto-generated at build time from Vercel env vars. Do not edit.
window.MAPBOX_TOKEN = ${JSON.stringify(MAPBOX_TOKEN)};
window.SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};
window.SUPABASE_ANON_KEY = ${JSON.stringify(SUPABASE_ANON_KEY)};
`;

const outPath = path.join(__dirname, '..', 'public', 'config.js');
fs.writeFileSync(outPath, content);
console.log('[build-config] Wrote', outPath);
