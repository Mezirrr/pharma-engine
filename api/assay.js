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

async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 8000) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} – ${body.slice(0, 200)}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (i === retries) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
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
  if (!recent?.length) return;

  const historyText = recent
    .map((s, i) => `${i + 1}. Target(s): ${s.target_searched} | Goal: ${s.goal_input || 'n/a'}`)
    .join('\n');

  const system = `You write extremely terse researcher‑focus summaries. Given recent search queries, output ONLY a single plain‑text synthesis, ≤50 words. No preamble, no JSON.`;

  try {
    const res = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: historyText }
        ]
      })
    }, 1, 6000);
    const data = await res.json();
    const synth = data?.choices?.[0]?.message?.content?.trim();
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

export default async function handler(req, res) {
  const rid = Math.random().toString(36).slice(2, 8);
  console.log(`[${rid}] Incoming assay request`);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authentication required.' });
  const token = authHeader.replace('Bearer ', '');
  let user;
  try {
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authUser) throw authError;
    user = authUser;
    console.log(`[${rid}] Auth OK – ${user.email}`);
  } catch (e) {
    console.error(`[${rid}] Auth error:`, e);
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
        console.log(`[${rid}] Super user detected – upgrading to Lab Rat`);
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

    console.log(`[${rid}] Profile – tier: ${profile.tier}, used: ${profile.assays_used_this_month}`);
  } catch (e) {
    console.error(`[${rid}] Profile error:`, e);
    return res.status(500).json({ error: 'Profile service error.' });
  }

  const period = currentPeriod();
  const used = profile.usage_period === period ? profile.assays_used_this_month : 0;
  const limit = TIER_LIMITS[profile.tier] ?? TIER_LIMITS.Free;
  if (used >= limit) {
    return res.status(403).json({
      error: `Monthly limit reached (${profile.tier}: ${limit}). Please upgrade to continue.`
    });
  }

  const maxTokens = TIER_MAX_TOKENS[profile.tier] || 5000;

  const { target, goal, typeLabel } = req.body;
  if (!target) return res.status(400).json({ error: 'No target' });

  const targetsArray = target.split(',').map(t => t.trim()).filter(Boolean);
  if (!targetsArray.length) return res.status(400).json({ error: 'No valid targets' });

  const targetsHeading = targetsArray.join(', ');
  const s2ApiKey = "s2k-zRgzPNUsqrylk6ST4j78YbPFDcq74woh6HR4Uawp";

  try {
    // ================== PHASE 1: ENHANCER ==================
    let enhancedGoal = goal || 'General pharmacological profile';
    let optimizedQueries = {};

    const enhSystem = `You are a biomedical search strategist. For each target, generate up to 5 complementary, high-yield search strings that capture different facets of the user's goal. Use synonyms, alternative terminologies, and broader/narrower concepts to maximise recall. Return ONLY valid JSON: {"enhancedGoal":"technical reframing of the overall goal (1-2 sentences)", "optimizedQueries":{"TargetName":["query1","query2",...]}}`;

    try {
      const enhRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [
            { role: 'system', content: enhSystem },
            { role: 'user', content: `Targets: ${targetsHeading}\nRaw Goal: ${goal || 'General info'}` }
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
      console.warn(`[${rid}] Enhancer fallback:`, e.message);
      for (const t of targetsArray) {
        optimizedQueries[t] = [`${t} ${goal || ''}`.trim()];
      }
    }

    for (const t of targetsArray) {
      if (!optimizedQueries[t] || optimizedQueries[t].length === 0) {
        optimizedQueries[t] = [`${t} ${goal || ''}`.trim()];
      }
      if (!optimizedQueries[t].includes(t)) {
        optimizedQueries[t].push(`${t} ${goal || ''}`.trim());
      }
    }

    // ================== PHASE 2: SEMANTIC SCHOLAR ==================
    let allPapers = [], fallbackTriggered = false;
    for (const target of targetsArray) {
      const queries = optimizedQueries[target] || [target];
      let targetPapers = [];
      for (let qi = 0; qi < queries.length; qi++) {
        if (qi > 0) await new Promise(r => setTimeout(r, 1200));
        const query = queries[qi];
        console.log(`[${rid}] S2 query ${qi + 1}/${queries.length} for "${target}": "${query}"`);
        const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=10&fields=paperId,title,url,year,abstract`;
        try {
          const s2Res = await fetchWithRetry(url, { headers: { 'x-api-key': s2ApiKey } }, 1, 6000);
          const s2Data = await s2Res.json();
          const papers = s2Data.data || [];
          if (papers.length) {
            const mapped = papers.map(p => ({
              title: p.title || 'Untitled',
              url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : ''),
              year: p.year || 'Unknown',
              abstract: p.abstract?.substring(0, 400) + '...' || '',
              associatedTarget: target
            })).filter(p => p.url);
            targetPapers.push(...mapped);
          }
          if (targetPapers.length >= 8) break;
        } catch (err) {
          console.error(`[${rid}] S2 error for "${query}":`, err.message);
        }
      }
      if (targetPapers.length === 0) {
        fallbackTriggered = true;
      }
      allPapers.push(...targetPapers);
    }

    if (allPapers.length === 0) {
      console.log(`[${rid}] Phase 2b: Last-ditch`);
      try {
        const lastRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: [
              { role: 'system', content: 'You are a search expert. Given a biomedical goal and target, output a single, extremely effective search query string (max 15 words) that would find relevant scientific literature. Return ONLY the query string, no JSON, no extra text.' },
              { role: 'user', content: `Targets: ${targetsHeading}\nGoal: ${goal || 'General info'}` }
            ]
          })
        }, 1, 5000);
        const lastData = await lastRes.json();
        let lastQuery = lastData?.choices?.[0]?.message?.content?.trim();
        if (lastQuery && lastQuery.length > 3) {
          console.log(`[${rid}] Last-ditch query: "${lastQuery}"`);
          await new Promise(r => setTimeout(r, 1200));
          const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(lastQuery)}&limit=10&fields=paperId,title,url,year,abstract`;
          const s2Res = await fetchWithRetry(url, { headers: { 'x-api-key': s2ApiKey } }, 1, 6000);
          const s2Data = await s2Res.json();
          const papers = s2Data.data || [];
          const mapped = papers.map(p => ({
            title: p.title || 'Untitled',
            url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : ''),
            year: p.year || 'Unknown',
            abstract: p.abstract?.substring(0, 400) + '...' || '',
            associatedTarget: targetsHeading
          })).filter(p => p.url);
          allPapers.push(...mapped);
        }
      } catch (e) {
        console.warn(`[${rid}] Last-ditch failed:`, e.message);
      }
    }

    const seen = new Set();
    const uniquePapers = allPapers.filter(p => {
      if (!p.url || seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    }).slice(0, 35);

    console.log(`[${rid}] Total unique papers: ${uniquePapers.length}`);

    // ================== PHASE 3: INITIAL SYNTHESIS ==================
    const researcherContext = profile.researcher_profile
      ? `\n\nKnown Researcher Focus Profile: ${profile.researcher_profile}`
      : '';

    const systemPrompt = `You are a 130-IQ elite biochemical intelligence engine specializing in cross-disciplinary synthesis and non-obvious mechanistic cross-linking.

Your task:
1. Under "directResponse", provide a hyper-analytical, flawlessly logical 130-IQ synthesis explaining the connection between the targets (${targetsHeading}) and the discovery goal. **Open with the single most clinically or mechanistically important headline statement in bold, then elaborate with deep molecular detail.** Use your extensive biomedical knowledge; only cite a paper if it genuinely supports the argument.
2. Under "followUpOptions", give exactly 3 deep, insightful follow-up questions (≤12 words each).
3. Under "results", include ONLY papers that are **directly relevant** to the user's specific query. Read the title and abstract of each paper; discard any paper that is clearly off-topic. If no paper is truly relevant, set "results" to an empty array []. For the papers you keep:
   - Write a ≤18-word relevance explanation.
   - Classify "studyType" as "In Vitro", "In Vivo", or "Human". Default to "In Vivo" if ambiguous.

Return ONLY raw JSON matching:
{
  "directResponse": "string",
  "followUpOptions": ["string","string","string"],
  "results": [
    { "title":"string", "url":"string", "source":"Semantic Scholar", "year":"string", "relevance":"string", "studyType":"In Vitro | In Vivo | Human" }
  ]
}${researcherContext}`;

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}
All Inputs: ${targetsHeading}
Original Goal: ${goal || 'General info'}
Enhanced Context: ${enhancedGoal}
Fallback active: ${fallbackTriggered}
Papers: ${JSON.stringify(uniquePapers, null, 2)}

Evaluate each paper. Only keep those that truly match the goal. Discard any paper that is about an unrelated topic. Return the JSON.`;

    const groqRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.4
      })
    }, 2, 12000);

    const groqData = await groqRes.json();
    const rawText = groqData.choices[0].message.content;
    console.log(`[${rid}] Groq raw (first 300):`, rawText.slice(0, 300));

    let finalJson;
    try {
      finalJson = extractJSON(rawText);
    } catch (e) {
      console.error(`[${rid}] JSON parse failed:`, e.message);
      return res.status(500).json({ error: 'AI returned invalid format.' });
    }

    // ================== PHASE 4: GAP‑FILLING (if <5 relevant results) ==================
    if (finalJson.results && finalJson.results.length < 5) {
      console.log(`[${rid}] Only ${finalJson.results.length} results – gap‑filling initiated.`);
      try {
        // Extract key concepts from the synthesis
        const gapExtractSystem = `You are a search strategy assistant. Based on the biomedical synthesis below, output a JSON array of up to 3 precise search strings (each ≤15 words) that would retrieve additional relevant literature. Return ONLY the JSON array, e.g. ["query1","query2","query3"].`;
        const gapRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: [
              { role: 'system', content: gapExtractSystem },
              { role: 'user', content: finalJson.directResponse }
            ],
            max_tokens: 200,
            temperature: 0.3
          })
        }, 1, 5000);

        const gapData = await gapRes.json();
        let gapQueries = [];
        try {
          const gapText = gapData.choices[0].message.content.trim();
          gapQueries = JSON.parse(gapText.replace(/```json\s*/g, '').replace(/```/g, ''));
        } catch (e) {
          console.warn(`[${rid}] Failed to parse gap queries, skipping.`);
        }

        // Fetch additional papers for each gap query
        let extraPapers = [];
        for (const q of gapQueries) {
          await new Promise(r => setTimeout(r, 1200)); // rate limit
          const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=5&fields=paperId,title,url,year,abstract`;
          try {
            const s2Res = await fetchWithRetry(url, { headers: { 'x-api-key': s2ApiKey } }, 1, 6000);
            const s2Data = await s2Res.json();
            const papers = s2Data.data || [];
            if (papers.length) {
              const mapped = papers.map(p => ({
                title: p.title || 'Untitled',
                url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : ''),
                year: p.year || 'Unknown',
                abstract: p.abstract?.substring(0, 400) + '...' || '',
                associatedTarget: targetsHeading
              })).filter(p => p.url);
              extraPapers.push(...mapped);
            }
          } catch (err) {
            console.error(`[${rid}] Gap S2 error:`, err.message);
          }
        }

        // Deduplicate and merge
        const allUniquePapers = [...uniquePapers, ...extraPapers].filter((p, idx, arr) => {
          if (!p.url) return false;
          return arr.findIndex(x => x.url === p.url) === idx;
        }).slice(0, 50);

        // Re‑synthesize the results array only, keeping directResponse and followUpOptions
        const mergeSystem = `You are a biomedical literature curator. You have an existing analysis (directResponse and followUpOptions) that must NOT be changed. However, you have an expanded list of papers. Please update the "results" array to include ALL papers from the new list that are relevant to the topic. You may remove any that are now seen as irrelevant. Keep the same JSON schema for each paper. Return ONLY the updated JSON with the same fields (directResponse, followUpOptions, results). The directResponse and followUpOptions must be identical to the provided ones.`;
        const mergePrompt = `Here is the existing JSON:
${JSON.stringify(finalJson, null, 2)}

Here are the additional papers (merged with original):
${JSON.stringify(allUniquePapers, null, 2)}

Return the updated JSON with the same directResponse and followUpOptions, but with the results array refined.`;

        const mergeRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: [
              { role: 'system', content: mergeSystem },
              { role: 'user', content: mergePrompt }
            ],
            max_tokens: 1500,
            temperature: 0.3
          })
        }, 1, 10000);

        const mergeData = await mergeRes.json();
        const mergeText = mergeData.choices[0].message.content;
        try {
          const mergedJson = extractJSON(mergeText);
          // Keep original synthesis and follow‑ups, only update results
          finalJson.results = mergedJson.results || finalJson.results;
        } catch (e) {
          console.warn(`[${rid}] Gap‑fill merge failed, keeping original results.`);
        }
      } catch (e) {
        console.warn(`[${rid}] Gap‑fill process failed:`, e.message);
      }
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
    console.error(`[${rid}] ❌ UNHANDLED:`, error);
    return res.status(500).json({ error: `Pipeline error: ${error.message.slice(0, 150)}` });
  }
}
