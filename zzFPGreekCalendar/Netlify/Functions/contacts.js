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

    const host = engageUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
    const base = `https://${host}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9'
    };

    // ── STEP 1: Paginate org list ──
    const orgs = [];
    let skip = 0;
    const top = 100;
    let totalExpected = null;

    while (true) {
      const url = `${base}/engage/api/discovery/search/organizations?query=&skip=${skip}&top=${top}&orderBy[0]=UpperName%20asc`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`CampusLabs API returned ${res.status}. Check the URL is a CampusLabs Engage site.`);
      const data = await res.json();
      const items = data.value || data.items || [];
      items.forEach(o => {
        const org = normalizeList(o, base);
        orgs.push(org);
      });
      if (totalExpected === null) totalExpected = data['@odata.count'] || data.totalCount || items.length;
      skip += top;
      if (items.length < top || orgs.length >= totalExpected || orgs.length >= 1500) break;
    }

    // ── STEP 2: Fetch detail profiles for Greek + priority campus orgs ──
    const greekKw = ['greek', 'fraternity', 'sorority', 'panhellenic', 'ifc', 'nphc', 'mgc', 'divine nine'];
    const campusKw = ['business', 'professional', 'women', 'honor', 'newspaper', 'media', 'student gov', 'cultural'];
    const greekOrgs = orgs.filter(o => o.categories.some(c => greekKw.some(k => c.toLowerCase().includes(k))));
    const campusOrgs = orgs.filter(o => !greekOrgs.includes(o) && o.categories.some(c => campusKw.some(k => c.toLowerCase().includes(k)))).slice(0, 30);
    const toDetail = [...greekOrgs, ...campusOrgs];

    const batchSize = 10;
    for (let i = 0; i < toDetail.length; i += batchSize) {
      const batch = toDetail.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async org => {
        if (!org.id) return null;
        try {
          const r = await fetch(`${base}/engage/api/discovery/organizations/${org.id}`, { headers });
          if (!r.ok) return null;
          return normalizeDetail(await r.json(), base);
        } catch { return null; }
      }));
      results.forEach((detail, idx) => {
        if (!detail) return;
        const orgIdx = orgs.findIndex(o => o.id === batch[idx].id);
        if (orgIdx >= 0) Object.assign(orgs[orgIdx], detail);
      });
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

function normalizeList(o, base) {
  // CampusLabs uses PascalCase. WebKey is the slug used in public-facing URLs.
  const webKey = o.WebKey || o.webKey || o.Slug || o.slug || null;
  const id = o.Id || o.id || null;
  // Use WebKey for URL (slug-based) — falls back to numeric ID
  const profileUrl = webKey
    ? `${base}/engage/organization/${webKey}`
    : (id ? `${base}/engage/organization/${id}` : null);

  return {
    id,
    name: o.Name || o.name || '',
    email: o.Email || o.email || null,
    phone: o.Phone || o.phone || null,
    website: o.ExternalWebsite || o.externalWebsite || null,
    instagram: null, twitter: null, facebook: null, tiktok: null,
    advisor: null, officers: [],
    profileUrl,
    categories: (o.CategoryNames || o.categoryNames || o.categories || [])
      .map(c => typeof c === 'string' ? c : (c.Name || c.name || '')).filter(Boolean),
    description: (o.ShortDescription || o.shortDescription || '').slice(0, 200)
  };
}

function normalizeDetail(o, base) {
  const sm = o.SocialMedia || o.socialMedia || {};
  const advisors = o.Advisors || o.advisors || [];
  const advisor = advisors[0] ? {
    name: `${advisors[0].FirstName || advisors[0].firstName || ''} ${advisors[0].LastName || advisors[0].lastName || ''}`.trim(),
    email: advisors[0].Email || advisors[0].email || null,
    phone: advisors[0].Phone || advisors[0].phone || null
  } : null;

  const officerRaw = o.Officers || o.officers || o.PositionedMembers || o.positionedMembers || [];
  const officers = officerRaw.slice(0, 8).map(p => ({
    position: p.Position || p.position || p.PositionName || p.positionName || '',
    name: `${p.FirstName || p.firstName || ''} ${p.LastName || p.lastName || ''}`.trim(),
    email: p.Email || p.email || p.EmailAddress || p.emailAddress || null,
    phone: p.Phone || p.phone || null
  })).filter(p => p.name || p.email);

  const webKey = o.WebKey || o.webKey || o.Slug || o.slug || null;
  const id = o.Id || o.id || null;
  const profileUrl = webKey
    ? `${base}/engage/organization/${webKey}`
    : (id ? `${base}/engage/organization/${id}` : null);

  return {
    id,
    email: o.Email || o.email || o.ContactEmail || o.contactEmail ||
           (advisor && advisor.email) || null,
    phone: o.Phone || o.phone || null,
    website: o.ExternalWebsite || o.externalWebsite || null,
    instagram: sm.InstagramUsername || sm.instagramUsername || null,
    twitter: sm.TwitterUsername || sm.twitterUsername || null,
    facebook: sm.FacebookAddress || sm.facebookAddress || null,
    tiktok: sm.TikTokUrl || sm.tiktokUrl || null,
    profileUrl,
    advisor, officers
  };
}
