import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const TIER_LIMITS = {
  Free: 3,
  Starter: 50,
  Researcher: 200,
  'Lab Rat': 999999
};

const TIER_MAX_TOKENS = {
  Free: 5000,
  Starter: 7500,
  Researcher: 10000,
  'Lab Rat': 15000
};

const PROFILE_SYNTHESIS_EVERY = 5;

// S2's public API is rate-limited (roughly 1 req/sec unauthenticated, more with a
// valid API key). Complex queries can legitimately take longer than 6s to resolve,
// so we give them more room and back off harder on 429s specifically.
const S2_TIMEOUT_MS = 10000;
const S2_RETRIES = 2;
const S2_BASE_DELAY_MS = 1200;

async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 8000) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error('HTTP ' + response.status + ' – ' + body.slice(0, 200));
        err.status = response.status;
        throw err;
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (i === retries) throw error;
      // Back off longer on rate limiting than on generic errors/timeouts
      const isRateLimited = error.status === 429;
      const delay = isRateLimited ? 3000 * (i + 1) : 1000 * (i + 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

async function maybeUpdateResearcherProfile(userId, newSearchCount) {
  if (newSearchCount % PROFILE_SYNTHESIS_EVERY !== 0) return;
  const { data: recent } = await supabaseAdmin
    .from('search_history')
    .select('target_searched, goal_input')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (!recent || !recent.length) return;

  const historyText = recent
    .map((s, i) => (i + 1) + '. Target(s): ' + s.target_searched + ' | Goal: ' + (s.goal_input || 'n/a'))
    .join('\n');

  const system = 'You write extremely terse researcher‑focus summaries. Given recent search queries, output ONLY a single plain‑text synthesis, ≤50 words. No preamble, no JSON.';

  try {
    const res = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: historyText }
        ]
      })
    }, 1, 6000);
    const data = await res.json();
    const synth = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content ? data.choices[0].message.content.trim() : null;
    if (synth) {
      await supabaseAdmin.from('profiles').update({ researcher_profile: synth }).eq('id', userId);
    }
  } catch (e) {
    console.error('Profile synthesis failed (non-critical):', e.message);
  }
}

function extractJSON(str) {
  let cleaned = str.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  cleaned = cleaned.replace(/[\s\r\n]+$/g, '');
  const first = cleaned.indexOf('{'), last = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No braces');
  let json = cleaned.slice(first, last + 1);
  json = json.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(json);
  } catch (e) {
    const stack = [];
    for (let i = 0; i < json.length; i++) {
      if (json[i] === '[' || json[i] === '{') stack.push(json[i]);
      else if (json[i] === ']' || json[i] === '}') stack.pop();
    }
    let fixed = json;
    while (stack.length) {
      const opener = stack.pop();
      fixed += opener === '[' ? ']' : '}';
    }
    return JSON.parse(fixed);
  }
}

function extractCompounds(text, excludeTerms = []) {
  if (!text) return [];
  const excludeLower = new Set(excludeTerms.map(t => t.toLowerCase()));
  const tokens = text.match(/\b(?=.*[a-zA-Z])(?=.*\d)[A-Za-z0-9\-]+\b/g) || [];
  return [...new Set(tokens)].filter(t => !excludeLower.has(t.toLowerCase()));
}

// Groq/open-weight models occasionally loop and repeat a full paragraph verbatim.
// This catches an exact-duplicate block (>= ~120 chars repeated back-to-back-ish)
// and trims the response to the first occurrence as a safety net on top of the
// prompt-level instruction not to repeat itself.
function trimRepeatedParagraph(text) {
  if (!text || text.length < 240) return text;
  const chunkLen = 120;
  for (let start = 0; start < text.length - chunkLen; start += 40) {
    const chunk = text.slice(start, start + chunkLen);
    const nextIdx = text.indexOf(chunk, start + chunkLen);
    if (nextIdx !== -1) {
      // Found the start of a repeat. Keep everything up to where the repeat begins.
      return text.slice(0, nextIdx).trim();
    }
  }
  return text;
}

export default async function handler(req, res) {
  const rid = Math.random().toString(36).slice(2, 8);
  console.log('[' + rid + '] Incoming assay request');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authentication required.' });
  const token = authHeader.replace('Bearer ', '');
  let user;
  try {
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authUser) throw authError;
    user = authUser;
    console.log('[' + rid + '] Auth OK – ' + user.email);
  } catch (e) {
    console.error('[' + rid + '] Auth error:', e);
    return res.status(401).json({ error: 'Invalid session.' });
  }

  // ---------- Profile ----------
  let profile;
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error && error.code === 'PGRST116') {
      await supabaseAdmin.from('profiles').insert({
        id: user.id,
        email: user.email,
        tier: 'Free',
        assays_used_this_month: 0,
        usage_period: currentPeriod(),
        search_count: 0
      });
      const { data: newProfile } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();
      profile = newProfile;
    } else if (error || !data) {
      throw error || new Error('Profile not found');
    } else {
      profile = data;
    }

    if (user.email === 'mezirrr@protonmail.com') {
      if (profile.tier !== 'Lab Rat') {
        console.log('[' + rid + '] Super user detected – upgrading to Lab Rat');
        await supabaseAdmin.from('profiles').update({
          tier: 'Lab Rat',
          assays_used_this_month: 0,
          usage_period: currentPeriod()
        }).eq('id', user.id);
        profile.tier = 'Lab Rat';
        profile.assays_used_this_month = 0;
        profile.usage_period = currentPeriod();
      }
    }

    console.log('[' + rid + '] Profile – tier: ' + profile.tier + ', used: ' + profile.assays_used_this_month);
  } catch (e) {
    console.error('[' + rid + '] Profile error:', e);
    return res.status(500).json({ error: 'Profile service error.' });
  }

  const period = currentPeriod();
  const used = profile.usage_period === period ? profile.assays_used_this_month : 0;
  const limit = TIER_LIMITS[profile.tier] || TIER_LIMITS.Free;
  if (used >= limit) {
    return res.status(403).json({
      error: 'Monthly limit reached (' + profile.tier + ': ' + limit + '). Please upgrade to continue.'
    });
  }

  const maxTokens = TIER_MAX_TOKENS[profile.tier] || 5000;

  const { target, goal, typeLabel } = req.body;
  if (!target) return res.status(400).json({ error: 'No target' });

  const targetsArray = target.split(',').map(t => t.trim()).filter(Boolean);
  if (!targetsArray.length) return res.status(400).json({ error: 'No valid targets' });

  const targetsHeading = targetsArray.join(', ');

  // S2 key moved to env var — it was hardcoded in source before, which is a
  // needless secret-exposure risk even for a server-side key. The S2 API works
  // without a key too (just at a lower rate limit), so we degrade gracefully
  // instead of throwing if it's missing.
  const s2ApiKey = process.env.S2_API_KEY;
  if (!s2ApiKey) {
    console.warn('[' + rid + '] No S2_API_KEY set — falling back to unauthenticated (lower rate limit) requests.');
  }
  const s2Headers = s2ApiKey ? { 'x-api-key': s2ApiKey } : {};

  const compoundsFromGoal = extractCompounds(goal, targetsArray);
  const compoundsFromTargets = extractCompounds(targetsHeading, targetsArray);
  const allCompounds = [...new Set([...compoundsFromGoal, ...compoundsFromTargets])];
  console.log('[' + rid + '] Detected compounds: ' + (allCompounds.join(', ') || 'none'));

  try {
    // ================== PHASE 1: ENHANCER ==================
    let enhancedGoal = goal || 'General pharmacological profile';
    let optimizedQueries = {};

    // IMPORTANT: Semantic Scholar's /paper/search endpoint is a relevance-ranked
    // freetext search, not a boolean query parser. Quotes, AND/OR, and parentheses
    // are NOT interpreted as logic — they're just extra literal characters that
    // dilute the match and often return zero results. Queries need to read like
    // something a person would type into a search box: short, plain, keyword-based.
    const enhSystem = 'You are a biomedical search strategist writing queries for a plain keyword-based academic search API (NOT a boolean/database query language — it does not support AND/OR/quotes/parentheses as logic, they are just treated as literal text and will hurt results). ' +
      'For each target, generate up to 5 short, natural-language search phrases (3-8 words each, no quotes, no AND/OR, no parentheses) that capture different facets of the goal — vary terminology, use synonyms, broader and narrower concepts. ' +
      'Write them the way you would type into Google Scholar. Return ONLY valid JSON: {"enhancedGoal":"technical reframing of the overall goal (1-2 sentences)", "optimizedQueries":{"TargetName":["query1","query2",...]}}';

    try {
      const enhRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [
            { role: 'system', content: enhSystem },
            { role: 'user', content: 'Targets: ' + targetsHeading + '\nRaw Goal: ' + (goal || 'General info') }
          ]
        })
      }, 2, 6000);

      const enhData = await enhRes.json();
      const raw = enhData.choices[0].message.content;
      const parsed = extractJSON(raw);
      enhancedGoal = parsed.enhancedGoal || enhancedGoal;
      const rawQueries = parsed.optimizedQueries || {};
      for (const [t, q] of Object.entries(rawQueries)) {
        if (Array.isArray(q)) {
          optimizedQueries[t] = q.filter(s => typeof s === 'string' && s.trim().length);
        } else if (typeof q === 'string' && q.trim()) {
          optimizedQueries[t] = [q];
        } else {
          optimizedQueries[t] = [];
        }
      }
    } catch (e) {
      console.warn('[' + rid + '] Enhancer fallback:', e.message);
      for (const t of targetsArray) {
        optimizedQueries[t] = [t + ' ' + (goal || '').trim()];
      }
    }

    // Ensure each target has at least one query, and force compound queries
    for (const t of targetsArray) {
      if (!optimizedQueries[t]) optimizedQueries[t] = [];
      const rawGoalQuery = (t + ' ' + (goal || '')).trim();
      if (!optimizedQueries[t].includes(rawGoalQuery)) {
        optimizedQueries[t].push(rawGoalQuery);
      }
      for (const comp of allCompounds) {
        const compTargetQuery = comp + ' ' + t;
        if (!optimizedQueries[t].some(q => q.toLowerCase().includes(comp.toLowerCase()))) {
          optimizedQueries[t].unshift(compTargetQuery);
        }
      }
    }

    // ================== PHASE 2: SEMANTIC SCHOLAR ==================
    let allPapers = [], fallbackTriggered = false;
    for (const target of targetsArray) {
      const queries = optimizedQueries[target] || [target];
      let targetPapers = [];
      for (let qi = 0; qi < queries.length; qi++) {
        if (qi > 0) await new Promise(r => setTimeout(r, S2_BASE_DELAY_MS));
        const query = queries[qi];
        console.log('[' + rid + '] S2 query ' + (qi + 1) + '/' + queries.length + ' for "' + target + '": "' + query + '"');
        const url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + encodeURIComponent(query) + '&limit=10&fields=paperId,title,url,year,abstract';
        try {
          const s2Res = await fetchWithRetry(url, { headers: s2Headers }, S2_RETRIES, S2_TIMEOUT_MS);
          const s2Data = await s2Res.json();
          const papers = s2Data.data || [];
          console.log('[' + rid + '] S2 returned ' + papers.length + ' papers for "' + query + '"');
          if (papers.length) {
            const mapped = papers.map(p => ({
              title: p.title || 'Untitled',
              url: p.url || (p.paperId ? 'https://www.semanticscholar.org/paper/' + p.paperId : ''),
              year: p.year || 'Unknown',
              abstract: (p.abstract ? p.abstract.substring(0, 400) + '...' : ''),
              associatedTarget: target
            })).filter(p => p.url);
            targetPapers.push(...mapped);
          }
          if (targetPapers.length >= 8) break;
        } catch (err) {
          console.error('[' + rid + '] S2 error for "' + query + '":', err.message);
        }
      }
      if (targetPapers.length === 0) {
        fallbackTriggered = true;
      }
      allPapers.push(...targetPapers);
    }

    if (allPapers.length === 0) {
      console.log('[' + rid + '] Phase 2b: Last-ditch with raw goal');
      const lastQuery = (targetsHeading + ' ' + (goal || '')).trim();
      console.log('[' + rid + '] Last-ditch query: "' + lastQuery + '"');
      await new Promise(r => setTimeout(r, S2_BASE_DELAY_MS));
      const url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + encodeURIComponent(lastQuery) + '&limit=10&fields=paperId,title,url,year,abstract';
      try {
        const s2Res = await fetchWithRetry(url, { headers: s2Headers }, S2_RETRIES, S2_TIMEOUT_MS);
        const s2Data = await s2Res.json();
        const papers = s2Data.data || [];
        console.log('[' + rid + '] Last-ditch returned ' + papers.length + ' papers');
        const mapped = papers.map(p => ({
          title: p.title || 'Untitled',
          url: p.url || (p.paperId ? 'https://www.semanticscholar.org/paper/' + p.paperId : ''),
          year: p.year || 'Unknown',
          abstract: (p.abstract ? p.abstract.substring(0, 400) + '...' : ''),
          associatedTarget: targetsHeading
        })).filter(p => p.url);
        allPapers.push(...mapped);
      } catch (e) {
        console.warn('[' + rid + '] Last-ditch failed:', e.message);
      }
    }

    const seen = new Set();
    const uniquePapers = allPapers.filter(p => {
      if (!p.url || seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    }).slice(0, 35);

    console.log('[' + rid + '] Total unique papers: ' + uniquePapers.length);

    // ================== PHASE 3: SYNTHESIS ==================
    const researcherContext = profile.researcher_profile
      ? '\n\nKnown Researcher Focus Profile: ' + profile.researcher_profile
      : '';

    const systemPrompt = 'You are a 130-IQ elite biochemical intelligence engine specializing in cross-disciplinary synthesis and non-obvious mechanistic cross-linking.\n\n' +
      'Your task:\n' +
      '1. Under "directResponse", provide a hyper-analytical, flawlessly logical 130-IQ synthesis explaining the connection between the targets (' + targetsHeading + ') and the discovery goal. **Open with the single most clinically or mechanistically important headline statement in bold, then elaborate with deep molecular detail.** Use your extensive biomedical knowledge; only cite a paper if it genuinely supports the argument. IMPORTANT: write each point exactly once — do not restate, repeat, or re-summarize any sentence or paragraph you have already written.\n' +
      '2. **If the goal can be achieved or studied using specific small molecules, drugs, or compounds, mention up to 3 relevant examples (with names) and briefly state their known mechanisms, even if the supplied papers do not mention them.** Do this within the synthesis itself, after the main mechanistic explanation.\n' +
      '3. Under "followUpOptions", give exactly 3 deep, insightful follow-up questions (≤12 words each).\n' +
      '4. Under "results", include ONLY papers that are **directly relevant** to the user\'s specific query. Read the title and abstract of each paper; discard any paper that is clearly off-topic. If no paper is truly relevant, set "results" to an empty array []. For the papers you keep:\n' +
      '   - Write a ≤18-word relevance explanation.\n' +
      '   - Classify "studyType" as "In Vitro", "In Vivo", or "Human". Default to "In Vivo" if ambiguous.\n\n' +
      'Return ONLY raw JSON matching:\n' +
      '{\n  "directResponse": "string",\n  "followUpOptions": ["string","string","string"],\n  "results": [\n    { "title":"string", "url":"string", "source":"Semantic Scholar", "year":"string", "relevance":"string", "studyType":"In Vitro | In Vivo | Human" }\n  ],\n  "confidence": "high|low|none"\n}\n' +
      '- Set "confidence" to "high" if there are relevant papers that directly support the synthesis.\n' +
      '- Set "confidence" to "low" if only a few tangential papers exist.\n' +
      '- Set "confidence" to "none" if no papers were found – in that case the synthesis is based solely on general knowledge, and the "results" array must be empty [].' +
      researcherContext;

    const userPrompt = 'Target type: ' + (typeLabel || 'unspecified') + '\n' +
      'All Inputs: ' + targetsHeading + '\n' +
      'Original Goal: ' + (goal || 'General info') + '\n' +
      'Enhanced Context: ' + enhancedGoal + '\n' +
      'Fallback active: ' + fallbackTriggered + '\n' +
      'Papers: ' + JSON.stringify(uniquePapers, null, 2) + '\n\n' +
      'Evaluate each paper. Only keep those that truly match the goal. Discard any paper that is about an unrelated topic. Return the JSON.';

    const groqRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
        // Discourage the model from looping and repeating whole paragraphs,
        // a known failure mode on some open-weight models for long outputs.
        frequency_penalty: 0.4,
        presence_penalty: 0.2
      })
    }, 2, 12000);

    const groqData = await groqRes.json();
    const rawText = groqData.choices[0].message.content;
    console.log('[' + rid + '] Groq raw (first 300):', rawText.slice(0, 300));

    let finalJson;
    try {
      finalJson = extractJSON(rawText);
    } catch (e) {
      console.error('[' + rid + '] JSON parse failed:', e.message);
      return res.status(500).json({ error: 'AI returned invalid format.' });
    }

    // Safety net: trim any exact-duplicate paragraph the model produced despite
    // the prompt instruction and penalties above.
    if (typeof finalJson.directResponse === 'string') {
      finalJson.directResponse = trimRepeatedParagraph(finalJson.directResponse);
    }

    if (!finalJson.confidence) {
      finalJson.confidence = finalJson.results && finalJson.results.length > 0 ? 'low' : 'none';
    }

    finalJson.isFallback = fallbackTriggered;
    if (finalJson.results) finalJson.results.forEach(r => r.source = 'Semantic Scholar');

    // Usage update
    const usedNow = (profile.usage_period === period ? profile.assays_used_this_month : 0) + 1;
    const newCount = (profile.search_count || 0) + 1;

    await supabaseAdmin.from('profiles').update({
      assays_used_this_month: usedNow,
      usage_period: period,
      search_count: newCount
    }).eq('id', user.id);

    await supabaseAdmin.from('search_history').insert([{
      user_id: user.id,
      target_searched: targetsHeading,
      goal_input: goal
    }]);

    maybeUpdateResearcherProfile(user.id, newCount);

    return res.status(200).json(finalJson);
  } catch (error) {
    console.error('[' + rid + '] ❌ UNHANDLED:', error);
    return res.status(500).json({ error: 'Pipeline error: ' + error.message.slice(0, 150) });
  }
}
