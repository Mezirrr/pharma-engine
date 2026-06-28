export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { target, goal, typeLabel } = req.body;

  try {
    // Split targets by comma, trim spaces, filter empty values
    const targetsArray = target.split(',').map(t => t.trim()).filter(Boolean);
    
    if (targetsArray.length === 0) {
      return res.status(400).json({ error: 'No valid targets provided.' });
    }

    // Phase 1 & 2: Process ALL targets concurrently via Promise.all
    const targetResults = await Promise.all(targetsArray.map(async (singleTarget) => {
      const queryExpansionPrompt = `You are an elite biochemical intelligence engine. The user has a research target and a lateral discovery goal.
Target: ${singleTarget}
Goal: ${goal}

Generate a clean, professional, unquoted Semantic Scholar search query optimized to catch cross-disciplinary and mechanistic connections. 
- Do not include conversational filler.
- Provide a focused keyword string optimized for modern search (e.g., "molecule receptor mechanism"). Avoid complex boolean operators.
- Focus on underlying pathways, target receptors, and physiological mechanisms.

Respond with ONLY the raw query string.`;

      const expansionRes = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b', 
          messages: [{ role: 'user', content: queryExpansionPrompt }]
        })
      });

      const expansionData = await expansionRes.json();
      let optimizedQuery = `${singleTarget} ${goal}`.trim();
      if (expansionData.choices && expansionData.choices.length > 0) {
        optimizedQuery = expansionData.choices[0].message.content.trim().replace(/^"|"$/g, '');
      }

      // Fetch from Semantic Scholar API (US-hosted, fast REST API)
      let semanticRes = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(optimizedQuery)}&limit=20&fields=title,url,year,abstract,tldr`);
      let semanticData = await semanticRes.json();

      let localFallbackActive = false;
      // SMART FALLBACK per target thread
      if (!semanticData.data || semanticData.data.length === 0) {
        localFallbackActive = true;
        const fallbackQuery = `${singleTarget}`.trim();
        semanticRes = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(fallbackQuery)}&limit=20&fields=title,url,year,abstract,tldr`);
        semanticData = await semanticRes.json();
      }

      let mappedPapers = [];
      if (semanticData.data && semanticData.data.length > 0) {
        mappedPapers = semanticData.data.map(p => ({
          title: p.title,
          url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
          year: p.year ? p.year.toString() : 'Unknown',
          // Use AI-generated TLDR if available, otherwise truncate the abstract
          abstract: p.tldr && p.tldr.text 
            ? p.tldr.text 
            : (p.abstract ? p.abstract.substring(0, 400) + '...' : 'No abstract available'),
          associatedTarget: singleTarget 
        }));
      }

      return { mappedPapers, fallbackTriggered: localFallbackActive };
    }));

    // Recombine concurrently retrieved lists safely without race conditions
    let allRealPapers = [];
    let fallbackTriggered = false;

    for (const result of targetResults) {
      allRealPapers.push(...result.mappedPapers);
      if (result.fallbackTriggered) {
        fallbackTriggered = true;
      }
    }

    // Deduplicate papers globally by URL just in case searches overlap
    const seenUrls = new Set();
    const uniquePapers = allRealPapers.filter(p => {
      if (!p.url || seenUrls.has(p.url)) return false;
      seenUrls.add(p.url);
      return true;
    }).slice(0, 35); // Keep top 35 elements across all targets to filter down

    // Phase 3: Dynamic Multi-Target Synthesis
    const targetsHeading = targetsArray.join(', ');
    const systemPrompt = `You are an elite, highly open-minded scientific research assistant specializing in cross-disciplinary synthesis and non-obvious mechanistic cross-linking.

Your task is:
1. Under "directResponse", provide a highly technical, high-IQ synthesis explaining the conceptual, structural, biochemical, or clinical connection between the user's targets (${targetsHeading}) and their discovery goal.
   - Map out synergistic actions, shared metabolic pathways, or direct ligand-receptor convergence points.
   - Trace cross-talk, competing mechanisms, receptor saturation, and counter-regulatory loops.
   - Detail the explicit molecular mechanisms behind any combined toxicities or emergent pharmacological properties. 
2. Under "followUpOptions", provide exactly 3 deeply analytical follow-up questions (strings) investigating cascading enzymatic steps or structural affinities based on your analysis. Max 12 words each.
3. Select the top relevant papers (up to 15). 
   - Write a strict max 18-word "relevance" explanation for each, explicitly linking its findings to the target matrix.
   - Classify "studyType" strictly as: "In Vitro", "In Vivo", or "Human". Default to "In Vivo" if ambiguous.

Respond with ONLY raw JSON matching exactly this schema:
{
  "directResponse": "string",
  "followUpOptions": ["string", "string", "string"],
  "results": [
    {
      "title": "string",
      "url": "string",
      "source": "Semantic Scholar",
      "year": "string",
      "relevance": "string",
      "studyType": "In Vitro | In Vivo | Human"
    }
  ]
}`;

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}\nAll Inputs Requested: ${targetsHeading}\nGoal: ${goal || 'General info'}\nIs Fallback Broad Search Active: ${fallbackTriggered}\n\nHere are the real compiled papers found across targets:\n${JSON.stringify(uniquePapers, null, 2)}\n\nFilter and return the JSON.`;

    const groqRes = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b', 
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' } 
      })
    });

    const groqData = await groqRes.json();
    const text = groqData.choices[0].message.content;
    
    const finalJson = JSON.parse(text);
    finalJson.isFallback = fallbackTriggered;

    res.status(200).json(finalJson);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
