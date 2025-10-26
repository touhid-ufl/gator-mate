export default async function handler(req, res) {
  const allowOrigin = process.env.CORS_ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    if (!body || !body.course) return res.status(400).send("Invalid payload. Expect {course, ...}");
    const owner=process.env.REPO_OWNER, repo=process.env.REPO_NAME, branch=process.env.REPO_BRANCH||"main", token=process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token) return res.status(500).send("Server not configured. Missing env vars.");
    const ts=(body.savedAt?new Date(body.savedAt):new Date()).toISOString().replace(/[:.]/g,"-");
    let subdir='answers'; if(body.video_note) subdir='video-notes'; if(body.video_chat) subdir='video-chats';
    const path=`${subdir}/${body.course}/${ts}.json`;
    const apiUrl=`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    const contentStr=JSON.stringify(body,null,2);
    const ghRes = await fetch(apiUrl, { method:"PUT", headers:{ "Authorization":`Bearer ${token}`,"Content-Type":"application/json","Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28" }, body: JSON.stringify({ message:`Save ${subdir} for ${body.course} at ${ts}`, content: Buffer.from(contentStr,"utf8").toString("base64"), branch }) });
    const text = await ghRes.text();
    if(!ghRes.ok) return res.status(502).send(`GitHub error: ${text}`);
    const data = JSON.parse(text || "{}");
    return res.status(200).send(JSON.stringify({ ok:true, path, commit:data.commit?.sha }));
  } catch (err) { return res.status(500).send(err?.message || "Unknown error"); }
}