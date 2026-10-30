// Signed-in players (week 7). The frontend signs a short-lived token for a player who logged in
// with Google (its /api/game-token route) and sends it with create_room / join_room. It is an
// HS256 JWT signed with GAME_TOKEN_SECRET, which must be the same value on Vercel and Render.
// Without the secret every token is rejected and everyone simply plays as a guest.
const crypto = require('crypto');

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const hmac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

// Returns { id, name, image } for a valid, unexpired token, or null.
function verifyToken(token, secret = process.env.GAME_TOKEN_SECRET, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(`${h}.${p}`, secret));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString());
    claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch {
    return null;
  }
  if (header.alg !== 'HS256' || typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  return {
    id: claims.sub.slice(0, 64),
    name: String(claims.name || '').slice(0, 60),
    image: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture.slice(0, 500) : null,
  };
}

// Used by the tests (the frontend has its own copy in app/api/game-token).
function signToken(claims, secret) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(claims);
  return `${h}.${p}.${hmac(`${h}.${p}`, secret)}`;
}

// Reads "Authorization: Bearer <token>" from an Express request.
const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;

module.exports = { verifyToken, signToken, bearer };
