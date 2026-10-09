import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MultimodalService } from '../server/multimodal.service.js'
import { Storage, root } from '../server/storage.js'
import { WebSocketServer } from 'ws'
import { openRecognition } from '../server/voice/asr.js'

const env={DASHSCOPE_API_KEY:'unit-test',DASHSCOPE_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1'}
test('视觉请求发送真实图片，保持未知信息，不猜测口径',async()=>{
 let request:any
 const service=new MultimodalService(new Storage('/tmp'),env,async(_url,init)=>{
  request=JSON.parse(String(init!.body))
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'看板',start:null,end:null,metric:'unknown',unit:'元',region:null,amount:60000,uncertainties:['日期不清楚']})}}]}),{headers:{'Content-Type':'application/json'}})
 })
 const facts=await service.inspect(await readFile(join(root,'samples/dashboard.png')),'image/png','ai',new AbortController().signal)
 assert.equal(facts.metric,'unknown')
 assert.equal(facts.start,null)
 assert.ok(request.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'))
 assert.match(request.messages[0].content,/JSON/)
 await assert.rejects(service.compare(crypto.randomUUID(),facts,new AbortController().signal),/口径不完整/)
})
test('TTS 在同地域调用，传递取消信号并校验音频来源',async()=>{
 let endpoint='', signal:AbortSignal|undefined
 const service=new MultimodalService(new Storage('/tmp'),env,async(url,init)=>{
  endpoint=String(url);signal=init!.signal as AbortSignal
  return new Response(JSON.stringify({output:{audio:{url:'http://sample.oss-cn-beijing.aliyuncs.com/result.wav'}}}))
 })
 const controller=new AbortController()
 const url=await service.speak('华东净销售额下降。',controller.signal)
 assert.match(endpoint,/https:\/\/dashscope.aliyuncs.com\/api\/v1/)
 assert.ok(url.startsWith('https://'))
 controller.abort()
 assert.equal(signal!.aborted,true)
})
test('实时识别按句子拼接，结束整段录音才返回最终文本',async()=>{
 const server=new WebSocketServer({port:0})
 await new Promise<void>(resolve=>server.on('listening',()=>resolve()))
 const port=(server.address() as {port:number}).port
 let committed=false
 server.on('connection',socket=>{
  socket.on('message',raw=>{
   const packet=JSON.parse(raw.toString())
   if(packet.type==='session.update'){assert.equal(packet.session.turn_detection.type,'server_vad');socket.send(JSON.stringify({type:'session.updated'}))}
   if(packet.type==='input_audio_buffer.append'){
    socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.text',item_id:'1',text:'华东',stash:'销售'}))
    socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'1',transcript:'华东销售额'}))
    socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'2',transcript:'下降了吗？'}))
   }
   if(packet.type==='input_audio_buffer.commit')committed=true
   if(packet.type==='session.finish')socket.send(JSON.stringify({type:'session.finished'}))
  })
 })
 const events:{event:string;data?:Record<string,unknown>}[]=[]
 let ready!:()=>void, partial!:()=>void
 const prepared=new Promise<void>(resolve=>ready=resolve), textReady=new Promise<void>(resolve=>partial=resolve)
 const recognition=openRecognition(new AbortController().signal,(event,data)=>{events.push({event,data});if(event==='asr.ready')ready();if(event==='asr.partial'&&data?.text==='华东销售额下降了吗？')partial()},{key:'unit-test',url:`ws://127.0.0.1:${port}`})
 try{
  await prepared;recognition.append(Buffer.alloc(6400).toString('base64'));await textReady
  assert.ok(!events.some(e=>e.event==='asr.final'))
  recognition.finish();await recognition.done
  assert.equal(events.find(e=>e.event==='asr.final')?.data?.text,'华东销售额下降了吗？')
  assert.equal(committed,false)
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
