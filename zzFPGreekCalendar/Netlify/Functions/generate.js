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

    if (response.ok && data.content) {
      const textBlock = data.content.find(b => b.type === 'text');
      if (textBlock) {
        console.log('Claude response (first 500 chars):', textBlock.text.slice(0, 500));
      }
    } else {
      console.error('Anthropic error:', response.status, JSON.stringify(data));
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
