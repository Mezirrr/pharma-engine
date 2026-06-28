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

    // Format the real papers to show to Gemini
    const realPapers = pmcData.resultList.result.map(p => ({
        title: p.title,
        url: p.doi ? `https://doi.org/${p.doi}` : `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
        year: p.pubYear,
        abstract: p.abstractText ? p.abstractText.substring(0, 300) + '...' : 'No abstract'
    }));

    // 2. Send the REAL papers to Gemini to evaluate
    const systemPrompt = `You are a scientific literature assistant. I will provide you with a list of REAL academic papers pulled from PubMed/Europe PMC. 
Your job is to evaluate which ones actually match the user's research goal, select the top 8, and write a strict maximum 18-word "relevance" explanation for why it matters to their goal.

Respond with ONLY raw JSON matching exactly this schema:
{"results":[{"title":"string","url":"string","source":"PubMed","year":"string","relevance":"string"}]}`;

    const userPrompt = `Target type: ${typeLabel || 'unspecified'}\nTarget: ${target}\nGoal: ${goal || 'General info'}\n\nHere are the real papers I found:\n${JSON.stringify(realPapers, null, 2)}\n\nFilter and return the JSON.`;

    // Make the request to Google's Gemini API with lowered safety filters for medical queries
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        safetySettings: [
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ],
        generationConfig: {
          responseMimeType: "application/json" 
        }
      })
    });

    const geminiData = await geminiRes.json();
    
    // THIS CATCHES THE EXACT GOOGLE ERROR
    if (geminiData.error) {
       console.error("GOOGLE API ERROR:", JSON.stringify(geminiData.error, null, 2));
       throw new Error(`Google rejected the API key or request: ${geminiData.error.message}`);
    }
    
    if (!geminiData.candidates || geminiData.candidates.length === 0) {
       console.error("GEMINI BLOCKED RESPONSE:", JSON.stringify(geminiData, null, 2));
       throw new Error("Gemini returned an empty response. It might have triggered a safety block.");
    }
    
    // Extract and parse the JSON Gemini spits out
    const text = geminiData.candidates[0].content.parts[0].text;
    const finalData = JSON.parse(text);

    // 3. Send back to your frontend
    res.status(200).json(finalData);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
