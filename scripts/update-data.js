#!/usr/bin/env node
/**
 * Auto-updates public/strikes.json and public/totals.json using Groq's free
 * Llama 3.3 70B API. Called by GitHub Actions hourly.
 *
 * Env vars required: GROQ_API_KEY
 */

const fs = require('fs');
const path = require('path');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
    console.error('Missing GROQ_API_KEY environment variable');
    process.exit(1);
}

const STRIKES_PATH = path.join(__dirname, '..', 'public', 'strikes.json');
const TOTALS_PATH = path.join(__dirname, '..', 'public', 'totals.json');

const RSS_FEEDS = [
    { name: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
    { name: 'AJ', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { name: 'NYT', url: 'https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml' },
    { name: 'Reuters', url: 'https://www.reutersagency.com/feed/?taxonomy=best-sectors&post_type=best' }
];

// ===== RSS fetching (via rss2json free API) =====
async function fetchFeed(feed) {
    try {
        const url = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed.url)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.status !== 'ok') return [];
        return (data.items || []).map(item => ({
            source: feed.name,
            title: item.title || '',
            desc: (item.description || '').replace(/<[^>]*>/g, '').substring(0, 300),
            pubDate: item.pubDate
        }));
    } catch (e) {
        console.warn(`Feed ${feed.name} failed:`, e.message);
        return [];
    }
}

async function fetchAllFeeds() {
    const all = await Promise.all(RSS_FEEDS.map(fetchFeed));
    return all.flat();
}

// ===== Groq LLM call =====
async function callGroq(systemPrompt, userPrompt) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.2,
            response_format: { type: 'json_object' },
            max_tokens: 4096
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content in Groq response');
    return JSON.parse(content);
}

// ===== Dedupe key for strikes =====
function strikeKey(s) {
    return `${s.name}|${s.date}`.toLowerCase().replace(/\s+/g, ' ');
}

// ===== Main =====
async function main() {
    console.log('[1/5] Reading existing data...');
    const strikes = JSON.parse(fs.readFileSync(STRIKES_PATH, 'utf8'));
    const totals = JSON.parse(fs.readFileSync(TOTALS_PATH, 'utf8'));
    console.log(`  Current strikes: ${strikes.length}`);

    console.log('[2/5] Fetching RSS feeds...');
    const articles = await fetchAllFeeds();
    console.log(`  Fetched ${articles.length} articles`);

    if (articles.length === 0) {
        console.log('No articles fetched, skipping update');
        return;
    }

    // Keep only articles from the last 3 days
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const recent = articles.filter(a => {
        const t = new Date(a.pubDate).getTime();
        return t > cutoff;
    }).slice(0, 60);

    console.log(`[3/5] Calling Groq with ${recent.length} recent headlines...`);

    const existingKeys = new Set(strikes.map(strikeKey));
    const last20Strikes = strikes.slice(-20).map(s => ({
        name: s.name,
        date: s.date,
        attacker: s.attacker,
        killed: s.killed,
        injured: s.injured
    }));

    const systemPrompt = `You are a military conflict data extractor for the 2026 Iran war. Given news headlines, extract any NEW military strikes, casualty updates, or significant events.

Output JSON with this exact schema:
{
  "new_strikes": [
    {
      "name": "City — Target Name",
      "lat": 35.0,
      "lng": 51.0,
      "attacker": "US/Israel" | "Iran" | "Hezbollah" | "Israel" | "Maritime",
      "date": "Apr 7, 2026",
      "details": "Brief description (<200 chars)",
      "casualties": "Short summary",
      "killed": 0,
      "injured": 0
    }
  ],
  "totals_update": {
    "iran_killed": "3,540+",
    "iran_injured": "26,500+",
    "lebanon_killed": "1,461",
    "lebanon_injured": "4,430",
    "israel_killed": "29",
    "israel_injured": "6,950+",
    "us_killed": "14",
    "us_injured": "303"
  }
}

Rules:
- Only include NEW strikes not in the existing list
- Use real lat/lng coordinates (look up the city if needed)
- attacker must be one of: US/Israel, Iran, Hezbollah, Israel, Maritime
- date format: "Mon DD, YYYY" (e.g. "Apr 7, 2026")
- If no new strikes found, return empty new_strikes array
- Only update totals if headlines mention higher numbers
- Be conservative — only include clearly reported strikes, not speculation`;

    const userPrompt = `Recent strikes already tracked:
${JSON.stringify(last20Strikes, null, 2)}

Latest news headlines (last 3 days):
${recent.map((a, i) => `${i+1}. [${a.source}] ${a.title}\n   ${a.desc.slice(0, 200)}`).join('\n\n')}`;

    let llmResult;
    try {
        llmResult = await callGroq(systemPrompt, userPrompt);
    } catch (e) {
        console.error('Groq call failed:', e.message);
        process.exit(0); // don't fail the action, just skip this run
    }

    console.log('[4/5] Merging results...');
    const newStrikes = (llmResult.new_strikes || []).filter(s => {
        if (!s.name || !s.lat || !s.lng || !s.attacker || !s.date) return false;
        if (existingKeys.has(strikeKey(s))) return false;
        // Validate coordinates
        if (typeof s.lat !== 'number' || typeof s.lng !== 'number') return false;
        if (s.lat < -90 || s.lat > 90 || s.lng < -180 || s.lng > 180) return false;
        // Validate attacker
        const valid = ['US/Israel', 'Iran', 'Hezbollah', 'Israel', 'Maritime'];
        if (!valid.includes(s.attacker)) return false;
        return true;
    });

    console.log(`  New strikes after dedupe + validation: ${newStrikes.length}`);

    let changed = false;
    if (newStrikes.length > 0) {
        strikes.push(...newStrikes);
        fs.writeFileSync(STRIKES_PATH, JSON.stringify(strikes, null, 2));
        console.log(`  Wrote ${strikes.length} strikes to strikes.json`);
        changed = true;
    }

    // Update totals if LLM returned higher numbers
    if (llmResult.totals_update) {
        const u = llmResult.totals_update;
        const countryMap = {
            'Iran': { killed: u.iran_killed, injured: u.iran_injured },
            'Lebanon': { killed: u.lebanon_killed, injured: u.lebanon_injured },
            'Israel': { killed: u.israel_killed, injured: u.israel_injured },
            'US Military': { killed: u.us_killed, injured: u.us_injured }
        };
        let totalsChanged = false;
        totals.countries.forEach(c => {
            const update = countryMap[c.name];
            if (update && update.killed && update.killed !== c.killed) {
                c.killed = update.killed;
                totalsChanged = true;
            }
            if (update && update.injured && update.injured !== c.injured) {
                c.injured = update.injured;
                totalsChanged = true;
            }
        });
        if (totalsChanged) {
            totals.lastUpdated = new Date().toISOString();
            fs.writeFileSync(TOTALS_PATH, JSON.stringify(totals, null, 2));
            console.log('  Updated totals.json');
            changed = true;
        }
    }

    console.log(`[5/5] ${changed ? 'Done — changes written' : 'Done — no changes'}`);
}

main().catch(err => {
    console.error('Update script failed:', err);
    process.exit(1);
});
