// 分片直传 R2（multipart）
const PART_SIZE = 50 * 1024 * 1024;   // 50 MB
export async function upload(file){
  const name = crypto.randomUUID() + '.wav';
  // 1. 拿上传 ID
  const {uploadId, urls} = await fetch(`${window.WORKER_URL}/presign?name=${name}`).then(r=>r.json());
  // 2. 分片 PUT
  const parts = [];
  for(let i=0;i<urls.length;i++){
    const start = i*PART_SIZE, end = Math.min(file.byteLength, start+PART_SIZE);
    const res = await fetch(urls[i], {method:'PUT', body:file.slice(start,end)});
    parts.push({ETag:res.headers.get('etag'), PartNumber:i+1});
  }
  // 3. 完成
  await fetch(`${window.WORKER_URL}/complete?uploadId=${uploadId}&name=${name}`, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({parts})
  });
  return name;
}
