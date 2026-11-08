#!/usr/bin/env python3
"""Build source-anchored publish, media-readiness and playback sequence pages."""
from pathlib import Path
import xml.etree.ElementTree as ET
import json,html
ROOT=Path(__file__).resolve().parents[2]
import os
MOBILE=Path(os.environ.get('VELORA_MOBILE_ROOT', '/home/hieucutedangyeu/Velora-Mobile'))

def ref(prefix,path,anchor,after=20):
 lines=((ROOT if prefix=='backend' else MOBILE)/path).read_text().splitlines()
 start=next(i+1 for i,v in enumerate(lines) if anchor in v)
 return f'{prefix}:{path}:{start}-{min(len(lines),start+after)}'

def msg(a,b,label,*e,reply=False): return dict(type='message',**{'from':a,'to':b},label=label,sort='asynchSignal' if 'broker' in (a,b) else 'reply' if reply else 'synchCall',evidence=list(e))
def note(label,*e): return dict(type='ref',label=label,evidence=list(e))
def frame(operator,*operands): return dict(type='frame',operator=operator,operands=[dict(guard=g,steps=s) for g,s in operands])
C='apps/content-service/src/application/use-cases/create-reel.use-case.ts'
R='apps/content-service/src/infrastructure/repositories/content.repository.ts'
MP='apps/media-processing-service/src/application/use-cases/process-reel.use-case.ts'
PM='apps/media-processing-service/src/application/use-cases/prepare-reel-media.use-case.ts'
UR='src/hooks/useReels.ts'; UC='src/hooks/useReelCreator.ts'; LP='src/lib/localReelPlayback.ts'; VF='src/components/reels/ReelFeedItem.tsx'
create=ref('backend',C,'async execute',98); replay=ref('backend',C,'private reconcileReplay',16)
unique=ref('backend','apps/content-service/prisma/schema.prisma','@@unique([userId, publishIntentId])',1)
tx=ref('backend',R,'async createReelWithMediaJob',117)
lease=ref('backend',R,'async reserveReelUploadLease',51)
presign=ref('backend','apps/media-service/src/application/use-cases/get-presigned-url.use-case.ts','async execute',90)
upload=ref('mobile',UR,"'If-None-Match': '*'",24)
checkpoint=ref('mobile',UR,"completedStep: 'reel_created'",36)
intent=ref('mobile',UC,'const publishIntentId = createPublishIntentId()',36)
ack=ref('mobile',UC,'router.replace({',20)
prepare=ref('backend',PM,'async execute',331)
completed=ref('backend',R,'async completeMediaProcessing',88)
evidence=ref('backend',R,'async completeExistingHlsEvidence',128)
process=ref('backend',MP,'if (!isExistingHls)',36)
visual=ref('backend',MP,"failedStage = 'BUILDING_VISUAL_MANIFEST'",55)
outbox=ref('backend','apps/content-service/src/application/use-cases/dispatch-outbox-events.use-case.ts','async execute',85)
claim=ref('backend',R,'async claimProcessingAttempt',77)
index=ref('backend','apps/reel-indexing-service/src/application/use-cases/process-reel-index-job.use-case.ts','async execute',75)
resolver=ref('mobile','src/hooks/useOfflineReelVideoSource.ts','const shouldUseLocalVideo',2)
resolver_all=ref('mobile','src/hooks/useOfflineReelVideoSource.ts','return useMemo',70)
local=ref('mobile',LP,'export const commitLocalReelPlayback',72)
owner=ref('mobile',LP,'export const resolveAuthorizedLocalReelPlayback',37)
seek=ref('mobile',VF,'const setVideoRef = useCallback',26)
errors=ref('mobile',VF,'const handleVideoError',58)
retention=ref('mobile',LP,'export const cleanupExpiredLocalReelPlayback',57)

models=[dict(id='27-upload-retry',title='27 · Publish identity and durable retry reconciliation',participants=[('mobile','Mobile creator'),('gateway','API Gateway'),('media','Media service'),('content','Content service'),('db','Content DB / outbox'),('r2','R2 storage')],steps=[
 note('One logical Publish: acquire synchronous UI lock, generate secure UUID, and retain edited video source.',intent,ref('mobile',UC,'if (publishLockRef.current)',14)),
 frame('loop',('resume the same persisted intent after timeout, restart or recoverable failure',[
 frame('opt',('upload not checkpointed',[
 frame('opt',('presign missing or expired',[
 msg('mobile','gateway','Request upload authorization & presigned URL\n(Reel intent, file type)',presign),
 msg('gateway','media','Forward upload lease & presign request via RPC',presign),
 msg('media','content','Reserve 24-hour deterministic upload lease',lease),
 msg('content','db','Acquire key advisory lock & protect against cleanup',lease),
 msg('media','gateway','Return presigned upload URL & key (5-min expiry)',presign,reply=True),
 msg('gateway','mobile','Save upload checkpoint in local storage',presign,reply=True)])),
 msg('mobile','r2','Upload raw video directly to Cloudflare R2\n(PUT with If-None-Match: *)',upload),
 msg('r2','mobile','Confirm video upload (200 OK or already present)',upload,reply=True),
 note('Persist uploaded key. A lost upload response safely reuses the same immutable key.',upload)])),
 msg('mobile','gateway','Submit Reel publication with intent ID & metadata',create),
 msg('gateway','content','Forward validated Reel creation to Content Service',create),
 msg('content','db','Verify publish intent uniqueness in database',unique,create),
 frame('alt',('existing intent + matching fingerprint',[
 msg('content','gateway','Return existing canonical Reel (Idempotent replay)',replay,reply=True)]),('existing intent + conflicting fingerprint',[
 msg('content','gateway','Reject conflicting payload (HTTP 409 Conflict)',replay,reply=True)]),('no existing intent',[
 note('Check user-owned source. Under key lock, recheck object and cleanup/adoption fence.',create,tx),
 msg('content','db','Atomically commit Reel, adopt lease & queue outbox job',tx,unique),
 frame('alt',('transaction commits',[
 msg('db','content','Confirm Reel committed to database',tx,reply=True),
 note('Outbox dispatcher reliably publishes the media job; commit and delivery are separate.',outbox)]),('P2002 concurrent intent race',[
 msg('content','db','Concurrent race: Reload winning Reel by user & intent',create),
 note('Reconcile immutable fingerprint; return winner or 409. No second outbox event.',replay)]) ),
 msg('content','gateway','Acknowledge canonical Reel creation',create,reply=True)])),
 frame('alt',('HTTP acknowledgement arrives',[
 msg('gateway','mobile','Deliver confirmed Reel ID to mobile creator',checkpoint,reply=True),
 note('Persist creation + owner/device local preview; navigate to Reel detail immediately.',checkpoint,ack,local),
 note('Visibility and Series follow-ups resume on this Reel; their failures never restart upload.',checkpoint)]),('response lost or uncertain failure',[
 note('Keep pending operation. Replay same intent and uploaded key; never generate a new ID.',intent,checkpoint)]) )])),
 note('Retired source: HTTP 410. Explicit cancel then a new intentional Publish creates a new ID.',lease)
]),dict(id='28-media-processing',title='28 · Playback readiness before durable evidence and indexing',participants=[('broker','RabbitMQ jobs\nretry / DLQ'),('worker','Media processing worker'),('assets','FFmpeg / R2 assets'),('content','Content service'),('db','Content DB / outbox'),('publisher','Content outbox\ndispatcher'),('index','Indexing worker')],steps=[
 msg('broker','worker','Deliver source video transcode job from queue',claim),
 msg('worker','content','Claim processing lease for current transcode attempt',claim),
 note('Malformed jobs go to DLQ. Duplicate or stale claims acknowledge without altering state.',claim,ref('backend','apps/media-processing-service/src/infrastructure/controllers/media-processing.controller.ts','async handleReelMediaJob',85)),
 msg('worker','assets','Download video, apply trim/crop filters, and transcode HLS',prepare),
 msg('worker','assets','Upload HLS playlists, segments, and thumbnail to Cloudflare R2',prepare),
 note('Validate master manifest, variant playlists, and all segment resources for playback readiness.',ref('backend','apps/media-processing-service/src/application/use-cases/validate-reel-stream.use-case.ts','async execute',80)),
 msg('worker','content','Commit HLS playback assets and playback metadata',process),
 msg('content','db','Atomically mark Reel MEDIA_READY and queue evidence outbox job',completed),
 msg('content','worker','Confirm media status updated to ready for playback',completed,reply=True),
 msg('worker','broker','Acknowledge transcode job completion to queue',process),
 note('On accepted commit: Validated HLS is immediately playable! Worker returns before audio/visual evidence extraction.',process),
 msg('publisher','db','Claim committed multimodal evidence outbox jobs',outbox),
 msg('publisher','broker','Publish EXISTING_HLS evidence extraction job to RabbitMQ',outbox),
 msg('broker','worker','Deliver multimodal evidence extraction job to worker',completed),
 msg('worker','content','Claim evidence lease against completed media attempt',claim),
 msg('worker','assets','Extract audio track from validated HLS and upload audio manifest',ref('backend','apps/media-processing-service/src/application/use-cases/prepare-existing-hls-evidence.use-case.ts','async execute',100)),
 msg('worker','assets','Extract keyframes and upload checksummed visual manifest',visual),
 msg('worker','content','Commit audio and visual evidence manifests',visual),
 msg('content','db','Atomically commit evidence manifests and queue indexing outbox job',evidence),
 msg('publisher','broker','Dispatcher publishes indexing job to RabbitMQ queue',outbox),
 msg('broker','index','Deliver indexing job with audio and visual manifest dependencies',index),
 note('Existing checkpoints: transcription / vision, embeddings, semantic candidate commit; renew attempt leases.',index),
 note('Index / evidence failure preserves playable HLS. Retry publication precedes ACK; exhausted jobs go to DLQ; stale attempts cannot overwrite newer results.',ref('backend',R,'async failIndexing',43),ref('backend',MP,'catch (error',70))
]),dict(id='34-hls-streaming',title='34 · Owner-local preview and validated HLS handoff',participants=[('creator','Creator / detail view'),('registry','Owner + device\nlocal registry'),('resolver','Existing playback source hook'),('player','ReelVideo\ntrim / crop player'),('gateway','Gateway status endpoint'),('cdn','Validated HLS / cache')],steps=[
 msg('creator','registry','Save local playback registration\n(Retained original video, trim/crop, owner scope)',local),
 msg('creator','resolver','Resolve playback source for current authenticated owner',owner,resolver),
 frame('alt',('authorized local preview + (remote not ready or offline)',[
 msg('resolver','player','Play retained local original video with client-side crop/trim',resolver_all),
 note('Only uploading owner/device; backend stays PENDING / PROCESSING. Other viewers see processing placeholder.',owner)]),('validated remote HLS and existing offline-cache policy chooses cached stream',[
 msg('resolver','player','Play cached offline HLS manifest source',resolver_all)]),('validated remote HLS and online',[
 msg('resolver','player','Play validated remote HLS master stream',resolver_all),
 msg('player','cdn','Stream HLS segments directly from CDN / Cloudflare R2',resolver_all)]),('no usable authorized source',[
 note('Show queued, processing, failed or offline-unavailable state.',resolver_all)])),
 frame('loop',('media / evidence / index work still pending',[
 msg('creator','gateway','Poll Reel processing status via HTTP GET',ref('mobile',UR,'queryKey: queryKeys.reels.status',20)),
 msg('gateway','creator','Return Reel mediaStatus and indexStatus flags',ref('mobile','src/lib/reelProcessing.ts','export const getReelPlaybackAvailability',29),reply=True)])),
 frame('opt',('media COMPLETED + valid HLS URL arrives',[
 note('Existing HLS warmup / temporary offline cache runs independently for validated remote assets.',ref('mobile','src/lib/reel-prefetch.ts','export',95)),
 msg('resolver','player','Seamlessly transition player source to validated remote HLS',resolver_all,seek),
 note('Queue output-relative position on detach; trim wrapper adds source offset exactly once. Preserve mute / pause controls.',seek,ref('mobile','src/components/reels/create/trimmed-reel-video.tsx','seekRelativeToTrim',100)),
 frame('opt',('remote playback errors',[
 note('Bounded fallback: try each available remote/local candidate once. No backend media failure mutation.',errors)]))])),
 note('Actual local player source is pinned. Keep fallback after remote first frame; 14-day expiry and safe cleanup; revoke on logout/account switching. No device URI is sent to backend.',retention,owner)
])]

# RabbitMQ delivery is asynchronous; a denied claim never executes the pipeline.
media_model = next(model for model in models if model['id'] == '28-media-processing')
flow = media_model['steps']
flow[1], flow[2] = flow[2], flow[1]
media_model['steps'] = flow[:3] + [frame('opt', ('claimed current SOURCE_VIDEO attempt', flow[3:11]))] + [frame('opt', ('MEDIA_READY committed: durable background evidence job', flow[11:]))]

# Conditions are source-backed independently of their message bodies.
guard_evidence = {
 'resume the same persisted intent after timeout, restart or recoverable failure': [intent, ref('mobile', 'src/lib/reelPublishPersistence.ts', 'export const getPendingReelPublishOperation', 25)],
 'upload not checkpointed': [ref('mobile', UR, 'const uploadSource', 90)],
 'presign missing or expired': [ref('mobile', UR, 'const uploadSource', 50)],
 'existing intent + matching fingerprint': [create, replay],
 'existing intent + conflicting fingerprint': [create, replay],
 'no existing intent': [create],
 'transaction commits': [tx],
 'P2002 concurrent intent race': [create],
 'HTTP acknowledgement arrives': [checkpoint, ack],
 'response lost or uncertain failure': [checkpoint, ref('mobile', UC, 'createdReel = await createReelAsync(payload)', 40)],
 'claimed current SOURCE_VIDEO attempt': [claim, process],
 'MEDIA_READY committed: durable background evidence job': [completed, outbox],
 'authorized local preview + (remote not ready or offline)': [owner, resolver, resolver_all],
 'validated remote HLS and existing offline-cache policy chooses cached stream': [resolver_all],
 'validated remote HLS and online': [resolver_all],
 'no usable authorized source': [resolver_all],
 'media / evidence / index work still pending': [ref('mobile', UR, 'const shouldPoll', 35)],
 'media COMPLETED + valid HLS URL arrives': [resolver_all, ref('mobile', 'src/lib/reelProcessing.ts', 'export const isRemoteReelPlaybackReady', 5)],
 'remote playback errors': [errors],
}
def cite_guards(items):
 for step in items:
  if step['type'] == 'frame':
   for operand in step['operands']:
    operand['evidence'] = guard_evidence[operand['guard']]
    cite_guards(operand['steps'])
   step['evidence'] = list(dict.fromkeys(reference for operand in step['operands'] for reference in operand['evidence']))
for model in models:
 cite_guards(model['steps'])

STYLE='html=1;fontFamily=Arial;fontSize=15;fontColor=light-dark(#202020,#eeeeee);strokeColor=light-dark(#202020,#eeeeee);'

def build(m):
 p=ET.Element('diagram',id=m['id'],name=m['title']); g=ET.SubElement(p,'mxGraphModel',dx='0',dy='0',grid='1',gridSize='10',guides='1',tooltips='1',connect='1',arrows='1',fold='1',page='1',pageScale='1',pageWidth='2800',pageHeight='3800',background='#ffffff',adaptiveColors='auto',conformance='Practical UML sequence subset; native draw.io figure styles',scopeDescription=m['title'])
 root=ET.SubElement(g,'root'); ET.SubElement(root,'mxCell',id='0');ET.SubElement(root,'mxCell',id='1',parent='0')
 count=0; order=0; lanes={a:300+i*320 for i,(a,_) in enumerate(m['participants'])}; width=max(lanes.values())+250
 def cell(label,x,y,w,h,style=STYLE+'text;whiteSpace=wrap;align=center;verticalAlign=middle;fillColor=none;strokeColor=none;',e=(),**attrs):
  nonlocal count
  count+=1;c=ET.SubElement(root,'mxCell',id=f'flow{count}',value=html.escape(label).replace('\n','<br>'),vertex='1',parent='1',style=style,sourceEvidence=json.dumps(e),**attrs)
  ET.SubElement(c,'mxGeometry',x=str(x),y=str(y),width=str(w),height=str(h),**{'as':'geometry'});return c
 def edge(a,b,label,y,sort,e=()):
  nonlocal count,order
  count+=1;order+=1
  c=ET.SubElement(root,'mxCell',id=f'flow{count}',value=html.escape(label).replace('\n','<br>'),edge='1',parent='1',style=STYLE+'endArrow='+('open;dashed=1;' if sort=='reply' else 'open;endFill=0;' if sort=='asynchSignal' else 'block;endFill=1;')+'labelBackgroundColor=#ffffff;labelWidth=550;whiteSpace=wrap;align=center;',messageSort=sort,fromParticipant=a,toParticipant=b,order=str(order),sourceEvidence=json.dumps(e))
  geom=ET.SubElement(c,'mxGeometry',relative='1',**{'as':'geometry'})
  ET.SubElement(geom,'mxPoint',x=str(lanes[a]),y=str(y),**{'as':'sourcePoint'});ET.SubElement(geom,'mxPoint',x=str(lanes[b]),y=str(y),**{'as':'targetPoint'})
  ET.SubElement(geom,'mxPoint',x='0',y='-25',**{'as':'offset'})
 def steps(items,y,depth=0):
  for s in items:
   if s['type']=='message':edge(s['from'],s['to'],s['label'],y+55,s['sort'],s['evidence']);y+=125
   elif s['type']=='ref':
    cell('ref',180+depth*15,y+10,width-330-depth*30,70,STYLE+'shape=umlFrame;fillColor=light-dark(#ffffff,#181818);align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;',s['evidence'])
    cell(s['label'],188+depth*15,y+32,width-350-depth*30,44,STYLE+'text;whiteSpace=wrap;align=left;verticalAlign=middle;strokeColor=none;fillColor=none;',s['evidence']);y+=100
   else:
    top=y;f=cell(s['operator'],130+depth*15,y,width-220-depth*30,1,STYLE+'shape=umlFrame;fillColor=none;align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;',e=s['evidence'],interactionOperator=s['operator']);y+=50
    for j,o in enumerate(s['operands']):
     if j:cell('',145+depth*15,y,width-250-depth*30,1,STYLE+'fillColor=none;dashed=1;');y+=20
     cell('['+o['guard']+']',155+depth*15,y,width-280-depth*30,45,STYLE+'text;whiteSpace=wrap;align=left;strokeColor=none;fillColor=none;',o['evidence']);y=steps(o['steps'],y+60,depth+1)
    f.find('mxGeometry').set('height',str(y-top+15));y+=35
  return y
 cell(m['title'],130,20,width-220,50,STYLE+'text;fontSize=24;align=left;strokeColor=none;fillColor=none;')
 headers=[]
 for a,label in m['participants']:
  h=cell(label,lanes[a]-130,100,260,65,STYLE+'rounded=0;fillColor=#ffffff;whiteSpace=wrap;align=center;verticalAlign=middle;',participantId=a);headers.append((a,h))
 end=steps(m['steps'],200)
 for a,h in headers:
  count+=1;line=ET.Element('mxCell',id=f'life{count}',edge='1',parent='1',style=STYLE+'dashed=1;endArrow=none;')
  geom=ET.SubElement(line,'mxGeometry',relative='1',**{'as':'geometry'});ET.SubElement(geom,'mxPoint',x=str(lanes[a]),y='165',**{'as':'sourcePoint'});ET.SubElement(geom,'mxPoint',x=str(lanes[a]),y=str(end),**{'as':'targetPoint'});root.insert(2,line)
 m['participants']=[dict(id=a,label=b,kind='client' if a in ('mobile','creator','player','resolver','registry') else 'store' if a=='db' else 'external' if a in ('r2','assets','broker','cdn') else 'service',evidence=[]) for a,b in m['participants']]
 g.set('semanticModel',json.dumps(m,ensure_ascii=False,separators=(',',':')));g.set('pageHeight',str(end+100))
 return ET.tostring(p,encoding='unicode')

path=ROOT/'docs/diagrams/velora-current/velora-architecture.drawio'; document=path.read_text()
for m in models:
 start=document.index('<diagram id="'+m['id']+'"');end=document.index('</diagram>',start)+len('</diagram>')
 document=document[:start]+build(m)+document[end:]
path.write_text(document)
print('Rebuilt 27,28,34 with source-anchored sequence semantics and geometry')
