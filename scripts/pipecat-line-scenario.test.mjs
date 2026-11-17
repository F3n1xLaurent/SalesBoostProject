import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(file,withBreath=false) {
  let start;const digits=[],events=[];
  const call={handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},sendMediaTo(){},sendDigits(d){digits.push(d);},hangup(){this.handlers.disconnected?.();}};
  const socket={sent:[],targets:[],clears:0,send(raw){this.sent.push(JSON.parse(raw));},sendMediaTo(...args){this.targets.push(args);},stopMediaTo(){},clearMediaBuffer(){this.clears++;},close(){}};
  const players=[];
  const createPlayer=()=>{const p={handlers:{},paused:true,stopped:false,addEventListener(name,fn){this.handlers[name]=fn;},sendMediaTo(){},resume(){this.paused=false;},pause(){this.paused=true;},stop(){this.stopped=true;}};players.push(p);return p;};
  const data={to:'+79990000000',call_id:'synthetic',stream_url:'wss://test/media',event_url:'https://test/events',line_gate:true,
    background_audio:{url:'https://test/background.wav'}};
  if(withBreath)data.breath_audio={url:'https://test/breath.wav'};
  const context={require(){},Modules:{WebSocket:'ws',Conference:'conference'},
    AppEvents:{Started:'started'},CallEvents:{Connected:'connected',Disconnected:'disconnected',Failed:'failed',RecordStarted:'recorded'},
    PlayerEvents:{Started:'started',PlaybackFinished:'finished',Error:'error'},WebSocketAudioEncoding:{PCM16_16KHZ:'pcm16'},
    setTimeout(){return 1;},clearTimeout(){},
    Net:{httpRequest(url,callback,options){events.push(JSON.parse(options.postData));callback({code:200});}},
    VoxEngine:{customData:()=>JSON.stringify(data),addEventListener(name,fn){start=fn;},callPSTN:()=>call,
      createWebSocket:()=>socket,createURLPlayer:createPlayer,createConference:()=>({sendMediaTo(){},stop(){}}),terminate(){}}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context);start({sessionId:123});call.handlers.connected();socket.onopen();
  return {digits,events,call,socket,players,player:players[0],command(action,values={}){socket.onmessage({text:JSON.stringify({customEvent:'control',action,...values})});}};
}

for(const file of ['voximplant/scenario_voice_pipecat.js','voximplant/scenario_voice_pipecat_hypothesis.js']) {
  test(file+': breath survives manager barge-in and stops when agent starts',()=>{
    const s=fixture(file,true);s.command('set_output_enabled',{enabled:true});
    const cue=s.players[1];s.command('play_breath',{commandId:'b'.repeat(32)});
    assert.equal(cue.paused,false);
    s.command('clear_media');assert.equal(cue.stopped,false);
    s.command('begin_output',{tag:'pc-1'});assert.equal(cue.stopped,true);
    assert.equal(s.player.stopped,false);assert.equal(s.socket.targets.length,1);
  });
  test(file+': breath can stop at TTS readiness and cannot replay duplicate commands',()=>{
    const s=fixture(file,true);s.command('set_output_enabled',{enabled:true});
    const cue=s.players[1],commandId='c'.repeat(32);
    s.command('play_breath',{commandId});s.command('stop_breath');
    assert.equal(cue.stopped,true);const warm=s.players.at(-1);
    s.command('play_breath',{commandId});assert.equal(warm.paused,true);
    assert.equal(s.socket.clears,0);
  });
  test(file+': background starts at connection and survives speech gating',()=>{
    const s=fixture(file);s.command('begin_output',{tag:'pc-1'});
    assert.equal(s.socket.targets.length,0);assert.equal(s.player.paused,false);
    s.command('set_output_enabled',{enabled:true});s.command('begin_output',{tag:'pc-2'});
    assert.equal(s.socket.targets.length,1);assert.equal(s.player.paused,false);
    s.command('set_output_enabled',{enabled:false});s.command('begin_output',{tag:'pc-3'});
    assert.equal(s.socket.targets.length,1);assert.equal(s.player.paused,false);assert.equal(s.socket.clears,1);
  });
  test(file+': DTMF command retry is idempotent and returns actual accepted path',()=>{
    const s=fixture(file);const commandId='a'.repeat(32);
    s.command('send_dtmf',{digit:'1',commandId});s.command('send_dtmf',{digit:'1',commandId});
    s.command('send_dtmf',{digit:'2',commandId});
    assert.deepEqual(s.digits,['1']);assert.equal(s.socket.sent.at(-1).ok,false);
    assert.deepEqual(s.socket.sent.at(-1).path,['1']);
    if(file.endsWith('scenario_voice_pipecat.js'))assert.ok(s.events.some(e=>e.event==='ivr_selected'&&e.ivr_path[0]==='1'));
  });
  test(file+': rejects injected/multiple digits and limits navigation',()=>{
    const s=fixture(file);
    s.command('send_dtmf',{digit:'12',commandId:'a'.repeat(32)});
    s.command('send_dtmf',{digit:'1',commandId:'bad'});
    assert.equal(s.digits.length,0);
    for(let i=0;i<8;i++)s.command('send_dtmf',{digit:String(i),commandId:i.toString(16).padStart(32,'0')});
    assert.equal(s.digits.length,6);assert.equal(s.socket.sent.at(-1).ok,false);
  });
}
