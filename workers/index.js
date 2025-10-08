import { AwsClient } from 'https://cdn.skypack.dev/aws4fetch@1.0.17';

// 环境变量说明（在 Worker Settings → Variables 里添加）：
// R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / REPLICATE_API_TOKEN
const R2_REGION = 'auto';
const R2_BUCKET = 'whisper-upload';   // 你的 R2 桶名
const R2_ENDPOINT = `https://${R2_BUCKET}.r2.cloudflarestorage.com`;

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    switch(u.pathname){
      case '/presign':   return presign(u, env);
      case '/complete':  return complete(req, env);
      case '/status':    return status(u, env);
      default:           return new Response('ok');
    }
  }
};

/* 1. 返回 multipart 预签名 URL */
async function presign(u, env){
  const name = u.searchParams.get('name');
  const s3 = new AwsClient({accessKeyId:env.R2_ACCESS_KEY_ID, secretAccessKey:env.R2_SECRET_ACCESS_KEY, region:R2_REGION, service:'s3'});
  // 创建 multipart
  const create = await s3.fetch(`${R2_ENDPOINT}/${encodeURIComponent(name)}?uploads`, {method:'POST'});
  const {UploadId} = await create.text().then(t=>new DOMParser().parseFromString(t,'text/xml').querySelector('UploadId').textContent);
  const partCount = 3; // 固定 3 片，够用
  const urls = [];
  for(let i=1;i<=partCount;i++){
    const url = new URL(`${R2_ENDPOINT}/${encodeURIComponent(name)}`);
    url.searchParams.set('partNumber',i);
    url.searchParams.set('uploadId',UploadId);
    urls.push(await signer(url, env, 'PUT'));
  }
  return json({uploadId:UploadId, urls});
}

/* 2. 完成 multipart */
async function complete(req, env){
  const body = await req.json();
  const {uploadId, name} = new URL(req.url).searchParams;
  const s3 = new AwsClient({accessKeyId:env.R2_ACCESS_KEY_ID, secretAccessKey:env.R2_SECRET_ACCESS_KEY, region:R2_REGION, service:'s3'});
  const xml = `<CompleteMultipartUpload>${body.parts.map(p=>`<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
  await s3.fetch(`${R2_ENDPOINT}/${encodeURIComponent(name)}?uploadId=${uploadId}`, {method:'POST', body:xml, headers:{'content-type':'application/xml'}});
  // 触发转写
  ctx.waitUntil(transcribe(name, env));
  return json({ok:true});
}

/* 3. 查询转写结果 */
async function status(u, env){
  const key = u.searchParams.get('key');
  const s3 = new AwsClient({accessKeyId:env.R2_ACCESS_KEY_ID, secretAccessKey:env.R2_SECRET_ACCESS_KEY, region:R2_REGION, service:'s3'});
  const r = await s3.fetch(`${R2_ENDPOINT}/srt/${encodeURIComponent(key.replace('.wav','.srt'))}`, {method:'HEAD'});
  if(r.status===200){
    const url = await signer(new URL(`${R2_ENDPOINT}/srt/${encodeURIComponent(key.replace('.wav','.srt'))}`), env, 'GET');
    return new Response(url);
  }
  return new Response('not ready',{status:202});
}

/* 4. 调 Replicate 免费 GPU */
async function transcribe(audioKey, env){
  const replicate = {token:env.REPLICATE_API_TOKEN};
  const input = {audio:`https://${R2_BUCKET}.r2.cloudflarestorage.com/${encodeURIComponent(audioKey)}`};
  const r = await fetch('https://api.replicate.com/v1/predictions',{
    method:'POST',
    headers:{Authorization:`Token ${replicate.token}`,'Content-Type':'application/json'},
    body:JSON.stringify({version:'ea6b8b0c25a5a6f0b6a093a4e9c5b6f0e0c0d0e0f0a0b0c0d0e0f0a0b0c0d0e0f', input}) // large-v3
  });
  const {id} = await r.json();
  let done = false;
  while(!done){
    await new Promise(r=>setTimeout(r,2000));
    const p = await fetch(`https://api.replicate.com/v1/predictions/${id}`,{headers:{Authorization:`Token ${replicate.token}`}}).then(res=>res.json());
    if(p.status==='succeeded'){
      done = true;
      // 把字幕写回 R2
      const srt = await fetch(p.output).then(res=>res.text());
      const s3 = new AwsClient({accessKeyId:env.R2_ACCESS_KEY_ID, secretAccessKey:env.R2_SECRET_ACCESS_KEY, region:R2_REGION, service:'s3'});
      await s3.fetch(`${R2_ENDPOINT}/srt/${encodeURIComponent(audioKey.replace('.wav','.srt'))}`, {method:'PUT', body:srt, headers:{'content-type':'text/plain'}});
    }
    if(p.status==='failed') break;
  }
}

/* 工具函数 */
function signer(url, env, method='GET', expires=900){
  const s3 = new AwsClient({accessKeyId:env.R2_ACCESS_KEY_ID, secretAccessKey:env.R2_SECRET_ACCESS_KEY, region:R2_REGION, service:'s3'});
  return s3.sign(url, {method, aws: {expires}}).url;
}
function json(obj){ return new Response(JSON.stringify(obj),{headers:{'content-type':'application/json'}}); }
