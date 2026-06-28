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

    // Phase 1 & 2: Process ALL targets concurrently
    const targetResults = await Promise.all(targetsArray.map(async (singleTarget) => {
      
      // SMART FIX 2: Native PubMed Syntax
      const queryExpansionPrompt = `You are an elite biochemical intelligence engine. 
Target: ${singleTarget}
Goal: ${goal}

Generate a highly optimized PubMed search query. 
- Use standard boolean operators (AND, OR).
- Use proper PubMed search tags where appropriate, such as [Title/Abstract] or [MeSH Terms].
- Keep it concise to ensure high yield.

Respond with ONLY the raw query string. Do not include quotes or conversational filler.`;

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

      // 1. E-Search: Get PMIDs
      let pubmedRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(optimizedQuery)}&retmode=json&retmax=15${ncbiApiKey}`);
      let pubmedData = await pubmedRes.json();
      let pmids = pubmedData.esearchresult?.idlist || [];

      let localFallbackActive = false;
      
      // SMART FALLBACK
      if (pmids.length === 0) {
        localFallbackActive = true;
        const fallbackQuery = `${singleTarget}[Title/Abstract]`.trim();
        pubmedRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(fallbackQuery)}&retmode=json&retmax=15${ncbiApiKey}`);
        pubmedData = await pubmedRes.json();
        pmids = pubmedData.esearchresult?.idlist || [];
      }

      let mappedPapers = [];
      
      // 2. E-Fetch: Get abstracts based on PMIDs
      if (pmids.length > 0) {
        const fetchRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=xml${ncbiApiKey}`);
        const xmlText = await fetchRes.text();

        const articles = xmlText.split('<PubmedArticle>');
        articles.shift(); 

        mappedPapers = articles.map(article => {
          const titleMatch = article.match(/<ArticleTitle[^>]*>(.*?)<\/ArticleTitle>/);
          const yearMatch = article.match(/<PubDate>[\s\S]*?<Year>(.*?)<\/Year>[\s\S]*?<\/PubDate>/) || article.match(/<MedlineDate>(.*?)<\/MedlineDate>/);
          const pmidMatch = article.match(/<PMID[^>]*>(.*?)<\/PMID>/);
          
          // SMART FIX 1: Stitch structured abstracts together
          const abstractMatches = [...article.matchAll(/<AbstractText[^>]*>(.*?)<\/AbstractText>/gs)];
          // Strip any stray internal XML/HTML tags (like <i> or <b>) from the abstract text
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

    // Phase 3: Dynamic Multi-Target Synthesis
    const targetsHeading = targetsArray.join(', ');
    
    // SMART FIX 3: Hallucination Guardrail
    const systemPrompt = `You are an elite, highly open-minded scientific research assistant specializing in cross-disciplinary synthesis and non-obvious mechanistic cross-linking.

Your task is:
1. Under "directResponse", provide a highly technical, high-IQ synthesis explaining the conceptual, structural, biochemical, or clinical connection between the user's targets (${targetsHeading}) and their discovery goal.
   - Map out synergistic actions, shared metabolic pathways, or direct ligand-receptor convergence points.
   - Trace cross-talk, competing mechanisms, receptor saturation, and counter-regulatory loops.
   - If the provided papers are irrelevant or empty, state this clearly, but STILL provide your best theoretical analysis based on your internal knowledge base.
2. Under "followUpOptions", provide exactly 3 deeply analytical follow-up questions (strings) investigating cascading enzymatic steps or structural affinities. Max 12 words each.
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
