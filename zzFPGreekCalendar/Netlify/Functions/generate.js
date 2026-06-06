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
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY not set');
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' })
    };
  }

  console.log('API key present, length:', apiKey.length, 'prefix:', apiKey.slice(0, 7));

  try {
    const requestBody = JSON.parse(event.body);
    console.log('Model:', requestBody.model, '| Tools:', JSON.stringify(requestBody.tools));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    console.log('Anthropic status:', response.status);

    if (!response.ok) {
      console.error('Anthropic error body:', JSON.stringify(data));
    } else {
      console.log('Success — content blocks:', data.content ? data.content.length : 0);
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
