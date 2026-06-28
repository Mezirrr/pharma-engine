// Smart Fetch Wrapper with Timeout and Retry Logic
async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 5000) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (i === retries) {
        console.warn(`Request failed after ${retries} retries: ${url}`);
        throw error;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { target, goal, typeLabel } = req.body;

  try {
    const targetsArray = target.split(',').map(t => t.trim()).filter(Boolean);
    
    if (targetsArray.length === 0) {
      return res.status(400).json({ error: 'No valid targets provided.' });
    }

    const ncbiApiKey = process.env.NCBI_API_KEY ? `&api_key=${process.env.NCBI_API_KEY}` : '';
    const targetsHeading = targetsArray.join(', ');

    // ==========================================
    // PHASE 1: Internal Pre-Enhancer
    // Reframes vague inputs into elite search vectors in a single call
    // ==========================================
    const enhancerSystemPrompt = `You are an elite biochemical intelligence engine. Optimize the user's inputs for literature retrieval.
Respond ONLY with JSON matching this schema:
{
  "enhancedGoal": "A hyper-technical reframing of the user's goal, expanding vague terms into specific mechanistic, enzymatic, or structural pathways (max 2 sentences).",
  "optimizedQueries": {
    "TargetName1": "PubMed query string using AND/OR, [MeSH Terms], and [Title/Abstract]",
    "TargetName2": "..."
  }
}`;

    const enhancerUserPrompt = `Targets: ${targetsHeading}\nRaw Goal: ${goal || 'General pharmacological profile and mechanisms'}`;
    
    let enhancedGoal = goal;
    let optimizedQueries = {};

    try {
      const enhancerRes = await fetchWithRetry(`https://api.groq.com/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b', 
          messages: [
            { role: 'system', content: enhancerSystemPrompt },
            { role: 'user', content: enhancerUserPrompt }
          ],
          response_format: { type: 'json_object' }
        })
      }, 2, 6000);

      const enhancerData = await enhancerRes.json();
      const enhancerJson = JSON.parse(enhancerData.choices[0].message.content);
      
      enhancedGoal = enhancerJson.enhancedGoal || goal;
      optimizedQueries = enhancerJson.optimizedQueries || {};
    } catch (e) {
      console.warn("Internal Enhancer skipped/failed, falling back to raw strings.", e.message);
    }

    // ==========================================
    // PHASE 2: Concurrent PubMed Fetching
    // Uses the optimized queries from Phase 1
    // ==========================================
    const targetResults = await Promise.all(targetsArray.map(async (singleTarget) => {
      
      // Map to the enhanced query, or fallback to a basic concatenation
      let optimizedQuery = optimizedQueries[singleTarget];
      if (!optimizedQuery) {
        optimizedQuery = `${singleTarget} ${enhancedGoal}`.trim();
      }

      // 1. E-Search: Get PMIDs
      let pubmedRes = await fetchWithRetry(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(optimizedQuery)}&retmode=json&retmax=15${ncbiApiKey}`, {}, 2, 6000);
      let pubmedData = await pubmedRes.json();
      let pmids = pubmedData.esearchresult?.idlist || [];

      let localFallbackActive = false;
      
      // SMART FALLBACK: If the enhanced query was too strict, loosen it.
      if (pmids.length === 0) {
        localFallbackActive = true;
        const fallbackQuery = `${singleTarget}[Title/Abstract]`.trim();
        pubmedRes = await fetchWithRetry(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(fallbackQuery)}&retmode=json&retmax=15${ncbiApiKey}`, {}, 2, 6000);
        pubmedData = await pubmedRes.json();
        pmids = pubmedData.esearchresult?.idlist || [];
      }

      let mappedPapers = [];
      
      // 2. E-Fetch: Get abstracts based on PMIDs
      if (pmids.length > 0) {
        const fetchRes = await fetchWithRetry(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=xml${ncbiApiKey}`, {}, 2, 6000);
        const xmlText = await fetchRes.text();

        const articles = xmlText.split('<PubmedArticle>');
        articles.shift(); 

        mappedPapers = articles.map(article => {
          const titleMatch = article.match(/<ArticleTitle[^>]*>(.*?)<\/ArticleTitle>/);
          const yearMatch = article.match(/<PubDate>[\s\S]*?<Year>(.*?)<\/Year>[\s\S]*?<\/PubDate>/) || article.match(/<MedlineDate>(.*?)<\/MedlineDate>/);
          const pmidMatch = article.match(/<PMID[^>]*>(.*?)<\/PMID>/);
          
          const abstractMatches = [...article.matchAll(/<AbstractText[^>]*>(.*?)<\/AbstractText>/gs)];
          const fullAbstract = abstractMatches.map(m => m[1]).join(' ').replace(/<[^>]*>?/gm, '');

          return {
            title: titleMatch ? titleMatch[1] : 'Unknown Title',
            url: pmidMatch ? `https://pubmed.ncbi.nlm.nih.gov/${pmidMatch[1]}/` : '',
            year: yearMatch ? yearMatch[1] : 'Unknown',
            abstract: fullAbstract ? fullAbstract.substring(0, 400) + '...' : 'No abstract available',
            associatedTarget: singleTarget 
          };
        }).filter(p => p.url); 
      }

      return { mappedPapers, fallbackTriggered: localFallbackActive };
    }));

    let allRealPapers = [];
    let fallbackTriggered = false;

    for (const result of targetResults) {
      allRealPapers.push(...result.mappedPapers);
      if (result.fallbackTriggered) {
        fallbackTriggered = true;
      }
    }

    const seenUrls = new Set();
    const uniquePapers = allRealPapers.filter(p => {
      if (!p.url || seenUrls.has(p.url)) return false;
      seenUrls.add(p.url);
      return true;
    }).slice(0, 35);

    // ==========================================
    // PHASE 3: Dynamic Multi-Target Synthesis
    // ==========================================
    const systemPrompt = `You are a 130-IQ, elite biochemical intelligence architecture specializing in cross-disciplinary synthesis and non-obvious mechanistic cross-linking.

Your task is:
1. Under "directResponse", provide a hyper-analytical, flawlessly logical 130-IQ synthesis explaining the conceptual, structural, biochemical, or clinical connection between the user's targets (${targetsHeading}) and their discovery goal.
   - Strike an authoritative, deeply academic, and highly technical tone. Avoid fluff, unnecessary introductory pleasantries, and thesaurus-bloat.
   - Map out explicit synergistic actions, shared metabolic pathways, or direct ligand-receptor convergence points.
   - Trace cross-talk, competing mechanisms, receptor saturation, and counter-regulatory loops.
   - Detail the exact molecular mechanisms behind any combined toxicities or emergent pharmacological properties.
   - If the provided papers are irrelevant or empty, state this clearly, but STILL provide your best theoretical analysis based on your internal knowledge base.
2. Under "followUpOptions", provide exactly 3 deeply analytical, highly insightful follow-up questions (strings) investigating cascading enzymatic steps or structural affinities. Max 12 words each.
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
      "source": "PubMed",
      "year": "string",
      "relevance": "string",
      "studyType": "In Vitro | In Vivo | Human"
    }
  ]
}`;

    // Note that we are passing the internal "Enhanced Context" here to ground the synthesis.
    const userPrompt = `Target type: ${typeLabel || 'unspecified'}
All Inputs Requested: ${targetsHeading}
Original Goal: ${goal || 'General info'}
Enhanced Analytical Context: ${enhancedGoal}
Is Fallback Broad Search Active: ${fallbackTriggered}

Here are the real compiled papers found across targets:
${JSON.stringify(uniquePapers, null, 2)}

Filter and return the JSON.`;

    const groqRes = await fetchWithRetry(`https://api.groq.com/openai/v1/chat/completions`, {
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
    }, 2, 12000);

    const groqData = await groqRes.json();
    const text = groqData.choices[0].message.content;
    
    const finalJson = JSON.parse(text);
    finalJson.isFallback = fallbackTriggered;

    res.status(200).json(finalJson);

  } catch (error) {
    console.error("API Pipeline Error:", error);
    res.status(500).json({ 
      error: "The analysis pipeline encountered a network instability or failed after multiple retries. Please try again." 
    });
  }
}
