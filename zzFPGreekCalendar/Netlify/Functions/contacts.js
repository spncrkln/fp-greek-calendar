exports.handler = async function(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { engageUrl } = JSON.parse(event.body || '{}');
    if (!engageUrl) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'engageUrl required' }) };

    // Normalize URL — strip trailing slash and path, keep host
    const host = engageUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();

    const orgs = [];
    let skip = 0;
    const top = 100;
    let total = null;

    // Paginate through the CampusLabs Engage API
    while (total === null || skip < total) {
      const apiUrl = `https://${host}/engage/api/discovery/search/organizations?query=&skip=${skip}&top=${top}&orderBy[0]=UpperName%20asc`;
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FreshPrintsBDM/1.0)',
          'Accept': 'application/json, text/plain, */*'
        }
      });

      if (!res.ok) {
        // Try alternate URL pattern
        const alt = `https://${host}/api/discovery/search/organizations?query=&skip=${skip}&top=${top}`;
        const res2 = await fetch(alt, { headers: { 'Accept': 'application/json' } });
        if (!res2.ok) throw new Error(`CampusLabs API returned ${res.status}. Check the URL.`);
        const d2 = await res2.json();
        (d2.value || d2.items || []).forEach(o => orgs.push(normalize(o)));
        total = d2['@odata.count'] || d2.total || orgs.length;
        break;
      }

      const data = await res.json();
      const items = data.value || data.items || data.organizations || [];
      items.forEach(o => orgs.push(normalize(o)));
      if (total === null) total = data['@odata.count'] || data.totalCount || data.total || items.length;
      skip += top;
      if (items.length < top) break; // last page
      if (orgs.length >= 1000) break; // safety cap
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgs, total: orgs.length, host })
    };

  } catch (err) {
    console.error('Contacts error:', err.message);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

function normalize(o) {
  return {
    id: o.id || o.organizationId || null,
    name: o.name || o.organizationName || '',
    email: o.email || o.contactEmail || o.primaryEmail || null,
    phone: o.contactPhone || o.phone || null,
    website: o.externalWebsite || o.websiteUrl || o.website || null,
    categories: (o.categories || o.categoryNames || []).map(c => typeof c === 'string' ? c : c.name || ''),
    description: (o.shortDescription || o.description || '').slice(0, 200)
  };
}
