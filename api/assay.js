export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { target, goal } = req.body;

  try {
    // 1. Fetch REAL papers from Semantic Scholar
    const searchQuery = `${target} ${goal}`.trim();
    const scholarRes = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(searchQuery)}&limit=15&fields=title,url,year,abstract`);
    const scholarData = await scholarRes.json();

    if (!scholarData.data || scholarData.data.length === 0) {
       return res.status(200).json({ results: [] });
    }

    // Format the real papers to show to Claude
    const realPapers = scholarData.data.map(p => ({
        title: p.title,
        url: p.url,
        year: p.year,
        abstract: p.abstract ? p.abstract.substring(0, 300) + '...' : 'No abstract'
    }));

    // 2. Send the REAL papers to Claude to evaluate
    const systemPrompt = `You are a scientific literature assistant. I will provide you with a list of REAL academic papers pulled from a database. 
Your job is to evaluate which ones actually match the user's research goal, select the top 8, and write a strict maximum 18-word "relevance" explanation for why it matters to their goal.

Respond with ONLY raw JSON matching exactly this schema:
{"results":[{"title":string,"url":string,"source":"Semantic Scholar","year":string|null,"relevance":string}]}`;

    const userPrompt = `Target: ${target}\nGoal: ${goal || 'General info'}\n\nHere are the real papers I found:\n${JSON.stringify(realPapers, null, 2)}\n\nFilter and return the JSON.`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY, // Pulls securely from Vercel!
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const anthropicData = await anthropicRes.json();
    
    // Extract the JSON Claude spits out
    const text = anthropicData.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const finalData = JSON.parse(jsonMatch[0]);

    // 3. Send back to your frontend
    res.status(200).json(finalData);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
