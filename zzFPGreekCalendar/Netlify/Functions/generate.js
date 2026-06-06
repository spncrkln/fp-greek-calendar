// Fresh Prints Greek Calendar — Netlify Function Proxy
// Forwards requests to Anthropic API, adding the API key server-side
// Set ANTHROPIC_API_KEY in Netlify Dashboard → Site Settings → Environment Variables

exports.handler = async function(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return {
    statusCode: 500,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' })
  };

  try {
    const requestBody = JSON.parse(event.body);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    // Strip markdown fences from Claude's text response server-side
    if (response.ok && data.content) {
      data.content = data.content.map(block => {
        if (block.type === 'text') {
          let text = block.text.trim();
          // Remove ```json or ``` wrappers
          text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '');
          text = text.replace(/\s*```\s*$/i, '').trim();
          console.log('Cleaned response starts with:', text.slice(0, 80));
          return { ...block, text };
        }
        return block;
      });
    } else {
      console.error('Anthropic error:', response.status, JSON.stringify(data).slice(0, 200));
    }

    return {
      statusCode: response.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    console.error('Exception:', err.message);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
