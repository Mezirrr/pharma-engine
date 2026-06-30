import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TIER_LIMITS = { Free: 5, Mini: 50, Max: 1000 };
const PROFILE_SYNTHESIS_EVERY = 5;

// Smart fetch with timeout & retry
async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 8000) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: historyText }
        ]
        // No response_format
      })
    }, 1, 6000);

    const data = await res.json();
    const synth = data?.choices?.[0]?.message?.content?.trim();
    if (synth) {
      await supabaseAdmin.from('profiles').update({ researcher_profile: synth }).eq('id', userId);
    }
  } catch (e) {
    console.warn('Profile synthesis skipped:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Auth
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authentication required.' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session.' });

  // 2. Profile
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) return res.status(403).json({ error: 'Profile not found.' });

  // 3. Tier limit
  const period = currentPeriod();
  const usedThisMonth = profile.usage_period === period ? profile.assays_used_this_month : 0;
  const limit = TIER_LIMITS[profile.tier] || TIER_LIMITS.Free;
  if (usedThisMonth >= limit) {
    return res.status(403).json({
      error: `Limit reached (${profile.tier} tier: ${limit}/month). Please upgrade.`
    });
  }

  const { target, goal, typeLabel } = req.body;
  if (!target) return res.status(400).json({ error: 'No target provided.' });

  const targetsArray = target.split(',').map(t => t.trim()).filter(Boolean);
  if (!targetsArray.length) return res.status(400).json({ error: 'No valid targets.' });

  const targetsHeading = targetsArray.join(', ');
  const s2ApiKey = "s2k-zRgzPNUsqrylk6ST4j78YbPFDcq74woh6HR4Uawp";

  try {
    // ===================== PHASE 1: Enhancer =====================
    let enhancedGoal = goal || 'General pharmacological profile';
    let optimizedQueries = {};

    const enhancerSystem = `You optimize biomedical search queries. Return ONLY valid JSON:
{
  "enhancedGoal": "technical reframing (max 2 sentences)",
  "optimizedQueries": { "TargetName": "keyword string" }
}`;

    const enhancerUser = `Targets: ${targetsHeading}\nRaw Goal: ${goal || 'General info'}`;

    try {
      const enhRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [
            { role: 'system', content: enhancerSystem },
            { role: 'user', content: enhancerUser }
          ]
          // No response_format – we parse the JSON manually
        })
      }, 2, 6000);

      const enhData = await enhRes.json();
      const raw = enhData.choices[0].message.content.trim();
      // Find the JSON object inside the response (just in case there's extra text)
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}') + 1;
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd));
        enhancedGoal = parsed.enhancedGoal || enhancedGoal;
        optimizedQueries = parsed.optimizedQueries || {};
      }
    } catch (e) {
      console.warn('Enhancer failed, using raw input:', e.message);
    }

    // ===================== PHASE 2: Semantic Scholar =====================
    let allPapers = [];
    let fallbackTriggered = false;

    for (let i = 0; i < targetsArray.length; i++) {
      const singleTarget = targetsArray[i];
      if (i > 0) await new Promise(r => setTimeout(r, 1200)); // rate limit

      let query = optimizedQueries[singleTarget] || `${singleTarget} ${enhancedGoal}`;
      let s2Url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=15&fields=paperId,title,url,year,abstract`;

      try {
        let s2Res = await fetchWithRetry(s2Url, { headers: { 'x-api-key': s2ApiKey } }, 1, 6000);
        let s2Data = await s2Res.json();
        let papers = s2Data.data || [];

        if (papers.length === 0) {
          fallbackTriggered = true;
          await new Promise(r => setTimeout(r, 1200));
          const fallbackUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(singleTarget)}&limit=15&fields=paperId,title,url,year,abstract`;
          s2Res = await fetchWithRetry(fallbackUrl, { headers: { 'x-api-key': s2ApiKey } }, 1, 6000);
          s2Data = await s2Res.json();
          papers = s2Data.data || [];
        }

        const mapped = papers.map(p => ({
          title: p.title || 'Untitled',
          url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : ''),
          year: p.year || 'Unknown',
          abstract: p.abstract ? p.abstract.substring(0, 400) + '...' : '',
          associatedTarget: singleTarget
        })).filter(p => p.url);

        allPapers.push(...mapped);
      } catch (err) {
        console.warn(`S2 fetch failed for ${singleTarget}:`, err.message);
      }
    }

    // Deduplicate
    const seen = new Set();
    const uniquePapers = allPapers.filter(p => {
      if (!p.url || seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    }).slice(0, 35);

    // ===================== PHASE 3: Synthesis =====================
    const researcherContext = profile.researcher_profile
      ? `\n\nResearcher Focus Profile (use to bias analysis subtly): ${profile.researcher_profile}`
      : '';

    const systemPrompt = `You are an elite biochemical intelligence engine. Return ONLY valid JSON (no markdown) following exactly this schema:
{
  "directResponse": "string (hyper‑analytical synthesis, technical tone)",
  "followUpOptions": ["string (max 12 words each)", ...],
  "results": [
    {
      "title": "paper title",
      "url": "paper url",
      "source": "Semantic Scholar",
      "year": "year",
      "relevance": "string (≤18 words linking to target matrix)",
      "studyType": "In Vitro | In Vivo | Human"
    }
  ]
}
Targets: ${targetsHeading}
Original Goal: ${goal || 'General'}
Enhanced Context: ${enhancedGoal}
Fallback active: ${fallbackTriggered}
Papers: ${JSON.stringify(uniquePapers)}
${researcherContext}`;

    const groqRes = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Filter and return JSON.' }
        ]
        // No response_format – we parse the JSON manually
      })
    }, 2, 12000);

    const groqData = await groqRes.json();
    const rawText = groqData.choices[0].message.content.trim();
    const jsonStart = rawText.indexOf('{');
    const jsonEnd = rawText.lastIndexOf('}') + 1;
    if (jsonStart === -1 || jsonEnd <= jsonStart) throw new Error('Groq did not return valid JSON.');

    const finalJson = JSON.parse(rawText.slice(jsonStart, jsonEnd));
    finalJson.isFallback = fallbackTriggered;
    if (finalJson.results) {
      finalJson.results.forEach(r => { r.source = 'Semantic Scholar'; });
    }

    // ===================== UPDATE USAGE =====================
    const newCount = (profile.search_count || 0) + 1;
    await supabaseAdmin.from('profiles').update({
      assays_used_this_month: usedThisMonth + 1,
      usage_period: period,
      search_count: newCount
    }).eq('id', user.id);

    await supabaseAdmin.from('search_history').insert([{
      user_id: user.id,
      target_searched: targetsHeading,
      goal_input: goal
    }]);

    await maybeUpdateResearcherProfile(user.id, newCount);

    return res.status(200).json(finalJson);

  } catch (error) {
    console.error('Pipeline error:', error);
    return res.status(500).json({
      error: 'The analysis pipeline failed. Please try again later.'
    });
  }
}
