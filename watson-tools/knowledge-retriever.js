'use strict';
// knowledge-retriever.js — Pull relevant knowledge into Ollama prompts
// Watson should USE what he learns, not just store it.
// When someone asks about blockchain, Watson should inject his blockchain
// knowledge into the system prompt so Ollama has real context.

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const KNOWLEDGE_DIR = '/sdcard/Android/data/md.obsidian/files/Wattson/knowledge';
const KNOWLEDGE_INDEX = `${HOME}/watson-knowledge-index.json`;
const RETRIEVAL_LOG = `${HOME}/watson-retrieval-log.jsonl`;

let linker;
try { linker = require('./knowledge-linker.js'); } catch { linker = null; }

// ─── Retrieve relevant knowledge for a prompt ──────────────────────────────

function retrieveForPrompt(userMessage, maxChars) {
  const limit = maxChars || 800;
  const query = userMessage.toLowerCase();

  // Strategy 1: Direct domain match
  const domainHits = findByDomainKeywords(query);

  // Strategy 2: Tag-based search (via knowledge-linker)
  let tagHits = [];
  if (linker) {
    tagHits = linker.findRelated(userMessage, 3);
  }

  // Merge and deduplicate
  const allHits = new Map();
  for (const hit of [...domainHits, ...tagHits]) {
    const key = hit.file || hit.filename;
    if (key && !allHits.has(key)) {
      allHits.set(key, hit);
    }
  }

  if (allHits.size === 0) return null;

  // Read and truncate knowledge content
  const chunks = [];
  let totalChars = 0;

  for (const [filename, hit] of allHits) {
    if (totalChars >= limit) break;

    const filepath = path.join(KNOWLEDGE_DIR, filename);
    try {
      const content = fs.readFileSync(filepath, 'utf8');
      // Extract the most recent section (latest knowledge)
      const sections = content.split(/\n---\n/);
      const latest = sections[sections.length - 1] || content;
      const trimmed = latest.substring(0, limit - totalChars);
      chunks.push(`[${hit.domain || 'knowledge'}] ${trimmed}`);
      totalChars += trimmed.length;
    } catch {}
  }

  if (chunks.length === 0) return null;

  // Log retrieval
  try {
    fs.appendFileSync(RETRIEVAL_LOG, JSON.stringify({
      ts: Date.now(),
      query: userMessage.substring(0, 100),
      filesFound: allHits.size,
      charsRetrieved: totalChars,
    }) + '\n');
  } catch {}

  return chunks.join('\n\n');
}

// ─── Domain keyword matching ────────────────────────────────────────────────

const DOMAIN_KEYWORDS = {
  'ai-ml':          ['ai', 'artificial intelligence', 'machine learning', 'neural', 'transformer', 'deep learning', 'model', 'training', 'gpt', 'llm'],
  'cybersecurity':  ['security', 'hacking', 'vulnerability', 'exploit', 'owasp', 'cyber', 'attack', 'firewall', 'encryption'],
  'blockchain':     ['blockchain', 'crypto', 'bitcoin', 'ethereum', 'smart contract', 'defi', 'nft', 'web3', 'solidity'],
  'physics':        ['physics', 'quantum', 'relativity', 'particle', 'energy', 'matter', 'atom', 'wave', 'force'],
  'neuroscience':   ['brain', 'neuron', 'consciousness', 'memory', 'cognitive', 'synapse', 'neural pathway'],
  'biology':        ['biology', 'gene', 'crispr', 'cell', 'dna', 'evolution', 'organism', 'protein'],
  'investing':      ['invest', 'stock', 'market', 'portfolio', 'dividend', 'value investing', 'buffett', 'returns'],
  'startups':       ['startup', 'saas', 'founder', 'business model', 'revenue', 'growth', 'mvp', 'product market'],
  'economics':      ['economics', 'inflation', 'gdp', 'monetary', 'fiscal', 'supply demand', 'market', 'trade'],
  'philosophy':     ['philosophy', 'consciousness', 'existence', 'ethics', 'moral', 'metaphysics', 'epistemology'],
  'psychology':     ['psychology', 'cognitive bias', 'behavior', 'mental', 'emotion', 'motivation', 'perception'],
  'nutrition':      ['nutrition', 'diet', 'fasting', 'vitamin', 'protein', 'calorie', 'health', 'food'],
  'productivity':   ['productivity', 'deep work', 'focus', 'time management', 'habit', 'flow state'],
  'history':        ['history', 'invention', 'revolution', 'empire', 'war', 'civilization', 'ancient'],
  'music-theory':   ['music theory', 'chord', 'scale', 'melody', 'harmony', 'rhythm', 'key signature'],
};

function findByDomainKeywords(query) {
  const results = [];

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = keywords.filter(k => query.includes(k)).length;
    if (score > 0) {
      // Find files in this domain
      try {
        const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f =>
          f.startsWith(domain + '--') && f.endsWith('.md')
        );
        for (const file of files) {
          results.push({ file, filename: file, domain, score });
        }
      } catch {}
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ─── Build augmented prompt with knowledge context ──────────────────────────

function augmentPrompt(originalPrompt, userMessage) {
  const knowledge = retrieveForPrompt(userMessage);
  if (!knowledge) return originalPrompt;

  return `${originalPrompt}\n\n--- Watson's Research Notes ---\nYou previously researched these topics. Use this knowledge in your response:\n${knowledge}\n--- End Research Notes ---\n`;
}

// ─── Get knowledge stats ────────────────────────────────────────────────────

function getKnowledgeStats() {
  try {
    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
    const domains = new Set();
    let totalSize = 0;

    for (const file of files) {
      const domainMatch = file.match(/^([^-]+)--/);
      if (domainMatch) domains.add(domainMatch[1]);
      try {
        totalSize += fs.statSync(path.join(KNOWLEDGE_DIR, file)).size;
      } catch {}
    }

    return {
      totalFiles: files.length,
      totalDomains: domains.size,
      domains: [...domains],
      totalSizeKB: Math.round(totalSize / 1024),
    };
  } catch {
    return { totalFiles: 0, totalDomains: 0, domains: [], totalSizeKB: 0 };
  }
}

// ─── Module exports ─────────────────────────────────────────────────────────

module.exports = {
  retrieveForPrompt,
  augmentPrompt,
  findByDomainKeywords,
  getKnowledgeStats,
};
