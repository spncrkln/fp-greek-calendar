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
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/html, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': `${base}/engage/organizations`
    };

    // ── STEP 1: Paginate the org list ──
    const orgs = [];
    let skip = 0;
    const top = 100;
    let totalExpected = null;

    while (true) {
      const url = `${base}/engage/api/discovery/search/organizations?query=&skip=${skip}&top=${top}&orderBy[0]=UpperName%20asc`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`CampusLabs API returned ${res.status}`);
      const data = await res.json();
      const items = data.value || data.items || [];
      items.forEach(o => {
        const org = normalizeList(o);
        org.profileUrl = `${base}/engage/organization/${org.id}`;
        orgs.push(org);
      });
      if (totalExpected === null) totalExpected = data['@odata.count'] || data.totalCount || items.length;
      skip += top;
      if (items.length < top || orgs.length >= totalExpected || orgs.length >= 1500) break;
    }

    // ── STEP 2: Fetch detail for Greek + priority orgs ──
    const greekKw = ['greek','fraternity','sorority','panhellenic','ifc','nphc','mgc','divine nine','multicultural greek'];
    const campusKw = ['business','professional','women','honor','newspaper','media','student gov','cultural','hispanic','black student','asian'];
    const greekOrgs = orgs.filter(o => o.categories.some(c => greekKw.some(k => c.toLowerCase().includes(k))));
    const campusOrgs = orgs.filter(o => !greekOrgs.includes(o) && o.categories.some(c => campusKw.some(k => c.toLowerCase().includes(k)))).slice(0, 30);
    const toDetail = [...greekOrgs, ...campusOrgs];

    // Try multiple endpoint patterns — CampusLabs versions vary
    async function fetchDetail(org) {
      const endpoints = [
        `${base}/engage/api/discovery/organizations/${org.id}`,
        `${base}/engage/api/organizations/${org.id}`,
        `${base}/api/discovery/organizations/${org.id}`
      ];
      for (const url of endpoints) {
        try {
          const r = await fetch(url, { headers });
          if (!r.ok) continue;
          const d = await r.json();
          const detail = normalizeDetail(d);
          if (detail.email || detail.instagram || (detail.officers && detail.officers.length)) {
            return detail;
          }
          // Got a response but no contact data — try HTML scrape
          break;
        } catch { continue; }
      }
      // Last resort: scrape the public HTML profile page
      return await scrapeOrgPage(org.profileUrl, headers);
    }

    // Batch detail fetches
    const batchSize = 10;
    for (let i = 0; i < toDetail.length; i += batchSize) {
      const batch = toDetail.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(org => fetchDetail(org).catch(() => null)));
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

// ── Scrape public HTML profile page for embedded contact data ──
async function scrapeOrgPage(profileUrl, headers) {
  try {
    const r = await fetch(profileUrl, { headers: { ...headers, Accept: 'text/html' } });
    if (!r.ok) return null;
    const html = await r.text();

    // Extract emails from anywhere in the page
    const emails = [...new Set((html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [])
      .filter(e => !e.includes('sentry') && !e.includes('campuslabs') && !e.includes('example') && !e.endsWith('.png')))];

    // Extract phone numbers
    const phones = (html.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g) || []);

    // Extract social handles from URLs
    const igMatch = html.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
    const twMatch = html.match(/twitter\.com\/([a-zA-Z0-9_]+)/);
    const fbMatch = html.match(/facebook\.com\/([a-zA-Z0-9_.\/\-]+)/);
    const tkMatch = html.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/);

    // Try to find embedded JSON data (__NEXT_DATA__, window.__DATA__, etc.)
    const jsonMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) ||
                      html.match(/window\.__(?:INITIAL|APP|STORE)_(?:DATA|STATE)__\s*=\s*({[\s\S]*?});\s*<\/script>/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        const flat = JSON.stringify(parsed);
        const jsonEmails = (flat.match(/"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}"/g) || [])
          .map(e => e.replace(/"/g, ''))
          .filter(e => !e.includes('campuslabs') && !e.includes('sentry'));
        emails.push(...jsonEmails);
      } catch {}
    }

    const email = emails[0] || null;
    return {
      email,
      phone: phones[0] || null,
      instagram: igMatch ? igMatch[1] : null,
      twitter: twMatch ? twMatch[1] : null,
      facebook: fbMatch ? fbMatch[0] : null,
      tiktok: tkMatch ? tkMatch[1] : null,
      officers: [],
      advisor: null
    };
  } catch { return null; }
}

function normalizeList(o) {
  return {
    id: o.Id || o.id || null,
    name: o.Name || o.name || '',
    email: o.Email || o.email || null,
    phone: o.Phone || o.phone || null,
    website: o.ExternalWebsite || o.externalWebsite || null,
    instagram: null, twitter: null, facebook: null, tiktok: null,
    advisor: null, officers: [],
    categories: (o.CategoryNames || o.categoryNames || o.categories || [])
      .map(c => typeof c === 'string' ? c : c.Name || c.name || '').filter(Boolean),
    description: (o.ShortDescription || o.shortDescription || '').slice(0, 200)
  };
}

function normalizeDetail(o) {
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

  // Also try to find email in nested data
  const allEmailFields = [
    o.Email, o.email, o.ContactEmail, o.contactEmail, o.PrimaryEmail, o.primaryEmail,
    o.EmailAddress, o.emailAddress, advisor && advisor.email,
    officers[0] && officers[0].email
  ].filter(Boolean);

  return {
    id: o.Id || o.id || null,
    email: allEmailFields[0] || null,
    phone: o.Phone || o.phone || o.ContactPhone || null,
    website: o.ExternalWebsite || o.externalWebsite || null,
    instagram: sm.InstagramUsername || sm.instagramUsername || sm.Instagram || sm.instagram || null,
    twitter: sm.TwitterUsername || sm.twitterUsername || sm.Twitter || sm.twitter || null,
    facebook: sm.FacebookAddress || sm.facebookAddress || sm.Facebook || sm.facebook || null,
    tiktok: sm.TikTokUrl || sm.tiktokUrl || sm.TikTok || sm.tiktok || null,
    advisor, officers
  };
}
