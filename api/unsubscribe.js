// One-click unsubscribe endpoint. Token-based, no auth needed.
// CAN-SPAM compliant. Required env: POSTGRES_URL

import pg from 'pg';
const { Pool } = pg;

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.POSTGRES_URL,
      ssl: { rejectUnauthorized: false },
      max: 3
    });
  }
  return pool;
}

function renderPage(title, body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    body{margin:0;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;color:#222;}
    .card{max-width:480px;margin:0 auto;background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.08);text-align:center;}
    h1{color:#d62828;font-size:24px;margin:0 0 16px;}
    p{font-size:16px;line-height:1.6;color:#444;margin:8px 0;}
    a.btn{display:inline-block;margin-top:16px;background:#d62828;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;}
  </style>
</head>
<body>
  <div class="card">
    ${body}
    <a class="btn" href="https://howdysummitcounty.com">Back to Howdy Summit</a>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  if (!process.env.POSTGRES_URL) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(503).send(renderPage('Service unavailable', '<h1>Unsubscribe unavailable</h1><p>The database is not reachable right now. Reply to any of our emails with the word UNSUBSCRIBE and we will remove you manually.</p>'));
  }

  const token = String(req.query.token || '').trim();
  if (!token || token.length < 20) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(renderPage('Invalid link', '<h1>Invalid unsubscribe link</h1><p>This link is missing or invalid. Reply to any email from us with UNSUBSCRIBE and we will remove you manually.</p>'));
  }

  try {
    const result = await getPool().query(
      'UPDATE subscribers SET unsubscribed_at = NOW() WHERE unsubscribe_token = $1 RETURNING email',
      [token]
    );
    if (result.rowCount === 0) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(404).send(renderPage('Not found', '<h1>Already unsubscribed</h1><p>This email is not on our active list. You are good. No more emails from us.</p>'));
    }
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(renderPage('Unsubscribed', `<h1>You are unsubscribed</h1><p>Removed <strong>${escapeHtml(result.rows[0].email)}</strong> from the Howdy Summit list.</p><p>Sorry to see you go. Howdysummitcounty.com is always free to use without email.</p>`));
  } catch (e) {
    console.error('unsubscribe error:', e.message);
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(renderPage('Error', '<h1>Could not unsubscribe</h1><p>Something went wrong. Reply to any email from us with UNSUBSCRIBE and we will remove you manually.</p>'));
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
