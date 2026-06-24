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

    // ── STEP 1: Paginate org list ──
    const orgs = [];
    let skip = 0;
    const top = 100;
    let totalExpected = null;

    while (true) {
      const url = `${base}/engage/api/discovery/search/organizations?query=&skip=${skip}&top=${top}&orderBy[0]=UpperName%20asc`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`CampusLabs returned ${res.status}. Verify the URL is a CampusLabs Engage site.`);
      const data = await res.json();
      const items = data.value || data.items || [];
      items.forEach(o => {
        const org = normalize(o);
        org.profileUrl = `${base}/engage/organization/${org.id}`;
        orgs.push(org);
      });
      if (totalExpected === null) totalExpected = data['@odata.count'] || data.totalCount || items.length;
      skip += top;
      if (items.length < top || orgs.length >= totalExpected || orgs.length >= 1500) break;
    }

    // ── STEP 2: Identify Greek orgs + high-value campus orgs ──
    const greekKeywords = ['greek', 'fraternity', 'sorority', 'panhellenic', 'ifc', 'nphc', 'mgc',
                           'divine nine', 'multicultural greek'];
    const campusPriorityKeywords = ['business', 'professional', 'women', 'hispanic', 'black',
                                    'asian', 'cultural', 'honor', 'newspaper', 'media', 'student gov'];

    const greekOrgs = orgs.filter(o =>
      o.categories.some(c => greekKeywords.some(k => c.toLowerCase().includes(k)))
    );
    const campusPriority = orgs.filter(o =>
      !greekOrgs.includes(o) &&
      o.categories.some(c => campusPriorityKeywords.some(k => c.toLowerCase().includes(k)))
    ).slice(0, 40);

    const toDetail = [...greekOrgs, ...campusPriority];

    // ── STEP 3: Fetch full profiles concurrently (batches of 15) ──
    const batchSize = 15;
    for (let i = 0; i < toDetail.length; i += batchSize) {
      const batch = toDetail.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async org => {
        if (!org.id) return null;
        try {
          const r = await fetch(`${base}/engage/api/discovery/organizations/${org.id}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
          });
          if (!r.ok) return null;
          return normalizeDetail(await r.json());
        } catch { return null; }
      }));

      results.forEach(detail => {
        if (!detail) return;
        const idx = orgs.findIndex(o => o.id === detail.id);
        if (idx >= 0) orgs[idx] = Object.assign(orgs[idx], detail);
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

// ── List endpoint fields (PascalCase) ──
function normalize(o) {
  return {
    id:          o.Id || o.id || null,
    name:        o.Name || o.name || '',
    email:       o.Email || o.email || o.ContactEmail || o.contactEmail || null,
    phone:       o.Phone || o.phone || null,
    website:     o.ExternalWebsite || o.externalWebsite || null,
    instagram:   null,
    twitter:     null,
    facebook:    null,
    advisor:     null,
    officers:    [],
    categories:  (o.CategoryNames || o.categoryNames || o.categories || [])
                   .map(c => typeof c === 'string' ? c : (c.Name || c.name || '')).filter(Boolean),
    description: (o.ShortDescription || o.shortDescription || '').slice(0, 200)
  };
}

// ── Individual profile endpoint (has full social + officer data) ──
function normalizeDetail(o) {
  // Social media — CampusLabs nests this in a SocialMedia object
  const sm = o.SocialMedia || o.socialMedia || {};
  const instagram = sm.InstagramUsername || sm.instagramUsername ||
                    sm.Instagram || sm.instagram || extractIG(o.ExternalWebsite) || null;
  const twitter   = sm.TwitterUsername || sm.twitterUsername ||
                    sm.Twitter || sm.twitter || null;
  const facebook  = sm.FacebookAddress || sm.facebookAddress ||
                    sm.Facebook || sm.facebook || null;
  const tiktok    = sm.TikTokUrl || sm.tiktokUrl || sm.TikTok || sm.tiktok || null;

  // Advisors
  const advisors = o.Advisors || o.advisors || [];
  const advisor  = advisors.length ? {
    name:  ((advisors[0].FirstName || advisors[0].firstName || '') + ' ' +
            (advisors[0].LastName  || advisors[0].lastName  || '')).trim(),
    email: advisors[0].Email || advisors[0].email || advisors[0].EmailAddress || null,
    phone: advisors[0].Phone || advisors[0].phone || null
  } : null;

  // Officers (decision makers — President, VP, Treasurer, etc.)
  const officerRaw = o.Officers || o.officers || o.PositionedMembers || o.positionedMembers || [];
  const officers = officerRaw.slice(0, 8).map(p => ({
    position: p.Position || p.position || p.PositionName || p.positionName || '',
    name: ((p.FirstName || p.firstName || '') + ' ' + (p.LastName || p.lastName || '')).trim(),
    email: p.Email || p.email || p.EmailAddress || p.emailAddress || null,
    phone: p.Phone || p.phone || null
  })).filter(p => p.name || p.email);

  return {
    id:        o.Id || o.id || null,
    email:     o.Email || o.email || o.ContactEmail || o.contactEmail ||
               (advisor && advisor.email) || null,
    phone:     o.Phone || o.phone || o.ContactPhone || null,
    website:   o.ExternalWebsite || o.externalWebsite || null,
    instagram, twitter, facebook, tiktok,
    advisor,   officers
  };
}

// Try to extract IG handle from a linktree or beacons URL if social field is empty
function extractIG(url) {
  if (!url) return null;
  const m = url.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
  return m ? m[1] : null;
}
