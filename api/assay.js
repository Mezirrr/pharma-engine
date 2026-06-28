export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { target, goal, typeLabel } = req.body;

  try {
    // 1. Fetch REAL papers from Europe PMC (PubMed)
    const searchQuery = `${target} ${goal}`.trim();
    const pmcRes = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(searchQuery)}&format=json&resultType=core&pageSize=15`);
    const pmcData = await pmcRes.json();

    if (!pmcData.resultList || !pmcData.resultList.result || pmcData.resultList.result.length === 0) {
       return res.status(200).json({ results: [] });
    }

    // Format the real papers to show to DeepSeek
    const realPapers = pmcData.resultList.result.map(p => ({
        title: p.title,
        url: p.doi ? `https://doi.org/${p.doi}` : `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
        year: p.pubYear,
        abstract: p.abstractText ? p.abstractText.substring(0, 300) + '...' : 'No abstract'
    }));

    // 2. Send the REAL papers to DeepSeek to evaluate
    const systemPrompt = `You are a scientific literature assistant. I will provide you with a list of REAL academic papers pulled from PubMed/Europe PMC. 
Your job is to evaluate which ones actually match the user's research goal, select the top 8, and write a strict maximum 18-word "relevance" explanation for why it matters to their goal.

Respond with ONLY raw JSON matching exactly this schema:
{"results":[{"title":"string","url":"string","source":"PubMed","year":"string","relevance":"string"}]}`;

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}\nTarget: ${target}\nGoal: ${goal || 'General info'}\n\nHere are the real papers I found:\n${JSON.stringify(realPapers, null, 2)}\n\nFilter and return the JSON.`;

    // Make the request to DeepSeek's API
    const dsRes = await fetch(`https://api.deepseek.com/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` // Using standard Bearer auth
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash', 
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' } // Forces perfect JSON parsing
      })
    });

    const dsData = await dsRes.json();
    
    // Catch DeepSeek specific errors
    if (dsData.error) {
       console.error("DEEPSEEK API ERROR:", JSON.stringify(dsData.error, null, 2));
       throw new Error(`DeepSeek rejected the request: ${dsData.error.message}`);
    }
    
    if (!dsData.choices || dsData.choices.length === 0) {
       console.error("DEEPSEEK BLOCKED RESPONSE:", JSON.stringify(dsData, null, 2));
       throw new Error("DeepSeek returned an empty response.");
    }
    
    // Extract and parse the JSON DeepSeek spits out
    const text = dsData.choices[0].message.content;
    const finalData = JSON.parse(text);

    // 3. Send back to your frontend
    res.status(200).json(finalData);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
