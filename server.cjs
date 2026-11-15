'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const faceapi = require('face-api.js');
const jpeg = require('jpeg-js');
const {PNG} = require('pngjs');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8768);
const secretFile = path.join(__dirname, '.secret');
const SECRET = process.env.FACE_SHARED_SECRET || (fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8').trim() : '');
if (SECRET.length < 32) throw new Error('Set FACE_SHARED_SECRET (or a private .secret file) to at least 32 characters.');
const THRESHOLD = Number(process.env.FACE_DISTANCE_THRESHOLD || 0.5);
if (!(THRESHOLD > 0 && THRESHOLD <= 1)) throw new Error('Invalid face distance threshold.');
let ready = false;
let busy = false;
class InputError extends Error {}
const referenceCache = new Map();
function decode(value) {
  if (typeof value !== 'string' || value.length > 2796204 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new InputError('Invalid image.');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new InputError('Use an image under 2 MB.');
  let width, height, image;
  if (bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) {
    if (bytes.length < 24) throw new InputError('Invalid PNG.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > 4000000) throw new InputError('Image exceeds 4 megapixels.');
    try { image = PNG.sync.read(bytes, {checkCRC:true}); } catch { throw new InputError('Invalid PNG image.'); }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    try { image = jpeg.decode(bytes, {useTArray:true, maxResolutionInMP:4, maxMemoryUsageInMB:64, tolerantDecoding:false}); }
    catch { throw new InputError('Invalid or oversized JPEG.'); }
    width = image.width; height = image.height;
  } else { throw new InputError('Use a JPEG or PNG image.'); }
  if (width < 80 || height < 80 || width * height > 4000000) throw new InputError('Use a clear image between 80 pixels per side and 4 megapixels.');
  const scale = Math.min(1, 640 / Math.max(width,height));
  const w = Math.max(1,Math.round(width*scale)), h = Math.max(1,Math.round(height*scale));
  const rgb = new Uint8Array(w*h*3);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    const source = (Math.min(height-1,Math.floor(y/scale))*width+Math.min(width-1,Math.floor(x/scale)))*4;
    const dest = (y*w+x)*3;
    rgb[dest]=image.data[source]; rgb[dest+1]=image.data[source+1]; rgb[dest+2]=image.data[source+2];
  }
  return faceapi.tf.tensor3d(rgb,[h,w,3],'int32');
}
async function descriptor(value, cache = false) {
  const hash = crypto.createHash('sha256').update(value).digest('hex');
  if (cache && referenceCache.has(hash)) return referenceCache.get(hash);
  const tensor = decode(value);
  let found;
  try {
    found = await faceapi.detectAllFaces(tensor, new faceapi.TinyFaceDetectorOptions({inputSize:320,scoreThreshold:0.5})).withFaceLandmarks(true).withFaceDescriptors();
  } finally { tensor.dispose(); }
  if (found.length !== 1) throw new InputError('Keep exactly one clear face in the image and try again.');
  const result = found[0].descriptor;
  if (cache) {
    if (referenceCache.size >= 32) referenceCache.delete(referenceCache.keys().next().value);
    referenceCache.set(hash,result);
  }
  return result;
}
function reply(res, code, body) {
  res.writeHead(code, {'Content-Type':'application/json','Cache-Control':'no-store'});
  res.end(JSON.stringify(body));
}
const server = http.createServer(async (req,res) => {
  if (req.url === '/health' && req.method === 'GET') return reply(res,200,{ready:ready && !busy});
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from('Bearer '+SECRET);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied,expected)) return reply(res,401,{error:'Unauthorized.'});
  if (req.method !== 'POST' || !['/enroll','/verify'].includes(req.url)) return reply(res,404,{error:'Not found.'});
  if (!ready || busy) return reply(res,503,{error:'Face matcher is starting or busy. Please try again.'});
  if (!(req.headers['content-type'] || '').startsWith('application/json')) return reply(res,415,{error:'JSON required.'});
  busy = true;
  try {
    let length=0;
    const chunks=[];
    for await (const chunk of req) {
      length+=chunk.length;
      if (length>6*1024*1024) throw new InputError('Request too large.');
      chunks.push(chunk);
    }
    let data;
    try { data=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('Invalid JSON.'); }
    if (!data || typeof data !== 'object') throw new InputError('Invalid request.');
    if (req.url === '/enroll') {
      await descriptor(data.photo);
      return reply(res,200,{valid:true});
    }
    const registered = await descriptor(data.registered,true);
    const scanned = await descriptor(data.photo);
    const distance = faceapi.euclideanDistance(registered,scanned);
    return reply(res,200,{matched:Number.isFinite(distance) && distance<=THRESHOLD});
  } catch (error) {
    if (!res.headersSent) reply(res,error instanceof InputError?422:503,{error:error instanceof InputError?error.message:'Face matching failed. Please retry.'});
    // No photos, templates or secret values are logged.
    if (!(error instanceof InputError)) console.error('Face inference failed:',error.name);
  } finally { busy=false; }
});
server.requestTimeout=15000;
server.headersTimeout=10000;
server.listen(PORT,HOST,async()=>{
  console.log(`Face matcher listening on ${HOST}:${PORT}; loading models.`);
  try {
    const models=path.join(__dirname,'models');
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromDisk(models),
      faceapi.nets.faceLandmark68TinyNet.loadFromDisk(models),
      faceapi.nets.faceRecognitionNet.loadFromDisk(models),
    ]);
    ready=true;
    console.log('Face models ready. No paid API is used.');
  } catch(error) { console.error('Unable to load model files:',error.name); server.close(()=>process.exit(1)); }
});
