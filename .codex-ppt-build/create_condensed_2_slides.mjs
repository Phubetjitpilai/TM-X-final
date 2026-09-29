import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

const workspaceDir='D:/All Work/TM-X React';
const buildDir=path.join(workspaceDir,'.codex-ppt-build');
const finalPath=path.join(workspaceDir,'output','Auto_Sorter_Actions_and_Outcomes_2_Slides.pptx');
const skillDir='C:/Users/User/.codex/plugins/cache/openai-primary-runtime/presentations/26.904.11930/skills/presentations';
const pythonExecutable='C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const {finalizePresentation}=await import(pathToFileURL(path.join(skillDir,'container_tools/artifact_tool_utils.mjs')).href);
await fs.mkdir(buildDir,{recursive:true});
await fs.mkdir(path.dirname(finalPath),{recursive:true});
const logo=await sharp(path.join(buildDir,'source-slides','slide-33.png')).extract({left:1068,top:38,width:190,height:53}).png().toBuffer();

const ppt=Presentation.create({slideSize:{width:1280,height:720}});
const C={navy:'#082A68',peach:'#F8E9E2',orange:'#C25418',orangePale:'#FBE8DC',blue:'#4B9BD3',bluePale:'#E7F4FB',dark:'#1B3157',gray:'#525C6C',line:'#C9CDD2',green:'#14AE3E',amber:'#E49A00'};
const noLine={fill:'none',width:0};
function box(slide,x,y,w,h,fill='none',stroke='none',sw=0,r=0){return slide.shapes.add({geometry:r?'roundRect':'rect',position:{left:x,top:y,width:w,height:h},fill,line:{style:'solid',fill:stroke,width:sw},...(r?{borderRadius:r}:{})})}
function txt(slide,value,x,y,w,h,size=22,color=C.navy,bold=false,align='left',vertical='middle'){
  const s=slide.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:noLine});
  s.text=value;s.text.style={typeface:'Arial',fontSize:size,bold,color,alignment:align,verticalAlignment:vertical,autoFit:'shrinkText',wrap:'square',insets:{left:0,right:0,top:0,bottom:0}};return s;
}
function header(slide,section,main='Actions'){
  slide.background.fill='#FFFFFF';
  txt(slide,main,92,64,150,54,34,C.navy,true);
  box(slide,250,64,440,52,C.peach);
  txt(slide,section,273,70,402,42,27,'#111111',true);
  slide.images.add({blob:logo,contentType:'image/png',position:{left:1068,top:37,width:190,height:53},fit:'contain',alt:'Analog Devices and partner logos from source presentation'});
  box(slide,0,704,1280,16,'#0A67A9');
}
function step(slide,x,title,body,number,color,pale){
  box(slide,x,232,350,247,pale,'#C5D0D8',1,8);
  box(slide,x,232,350,51,color);
  txt(slide,number,x+19,237,38,40,29,'#FFFFFF',true,'center');
  txt(slide,title,x+66,238,270,38,25,'#FFFFFF',true);
  txt(slide,body,x+24,303,302,140,24,C.dark,false,'left','top');
}

// Slide 1: the solution actions, condensed from source slides 33–39.
{
 const s=ppt.slides.add();header(s,'Auto Sorter Module');
 txt(s,'Three actions for ALPL measurement',91,139,1100,54,35,C.navy,true);
 txt(s,'Replace separate Excel records with one connected measurement process.',92,189,1100,33,22,C.gray);
 step(s,70,'Centralize setup','Register ALPL specifications and build the part queue in one web application.','1',C.orange,C.orangePale);
 step(s,465,'Automate decisions','Display each result and image live, then use the pass/fail decision to sort the part.','2',C.blue,C.bluePale);
 step(s,860,'Capture & report','Save every result with its image. Make records searchable and available for export.','3',C.blue,C.bluePale);
 box(s,70,507,1140,2,'#C4CED7');
 txt(s,'No manual result log',70,531,380,32,24,C.navy,true);
 txt(s,'Measurements and images are recorded automatically during the run.',70,570,500,76,22,C.dark,false,'left','top');
 txt(s,'Controlled changes',645,531,430,32,24,C.navy,true);
 txt(s,'Corrections are logged. Measured values stay locked, and deleted records can be recovered for 30 days.',645,570,540,76,22,C.dark,false,'left','top');
 s.speakerNotes.textFrame.setText('Condensed from source slides 33–39. Source 33–35 describe the web application, measurement records, and export. Source 36–39 describe validation, image pairing, data management, and sorting. The 30-day recovery and locked measured values are stated on source slide 34.');
}

// Slide 2: operational outcomes, condensed from 33–42.
{
 const s=ppt.slides.add();header(s,'Production & Quality','Outcomes');
 txt(s,'What the solution changes',91,139,1100,54,34,C.navy,true);
 txt(s,'Less recording work, consistent sorting, and a clearer view of quality.',92,189,1090,34,21,C.gray);
 const rows=[
  {y:245,title:'Less manual recording',body:'Results and images are saved with each run, so operators do not need to write them down.',accent:C.orange},
  {y:373,title:'Consistent sorting',body:'The same ALPL specification is applied to each measurement, and the pass/fail result directs sorting.',accent:C.blue},
  {y:501,title:'Clearer quality review',body:'Teams can search records and view Good/Fail counts by package size or part number, along with yield trends.',accent:C.blue},
 ];
 for(const [i,r] of rows.entries()){
   box(s,71,r.y,1138,112,'#FFFFFF','#C9CDD2',1,7);
   box(s,71,r.y,14,112,r.accent);
   txt(s,String(i+1).padStart(2,'0'),108,r.y+27,58,54,31,r.accent,true);
   txt(s,r.title,191,r.y+16,930,35,25,C.navy,true);
   txt(s,r.body,191,r.y+56,940,43,21,C.dark,false,'left','top');
 }
 s.speakerNotes.textFrame.setText('Condensed from source slides 33–42. Source 33 states that every reading is kept rather than written down. Source 36–39 describe measurement validation and sorting. Source 40–41 describe raw and summarized quality reporting. Source 42 database schema was omitted. The user confirmed all work is now complete, so no project status is shown.');
}

const candidatePath=path.join(buildDir,'actions-and-outcomes-candidate.pptx');
await (await PresentationFile.exportPptx(ppt)).save(candidatePath);
for(let i=0;i<2;i++){
 const png=await ppt.export({slide:ppt.slides.items[i],format:'png',scale:1});
 await fs.writeFile(path.join(buildDir,`actions-two-slide-${i+1}.png`),new Uint8Array(await png.arrayBuffer()));
}
const result=await finalizePresentation({
 explicitTotalSlideCount:2,
 requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],
 workspaceDir,candidatePath,finalPath,pythonExecutable,
 integrityValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_package_integrity.py'),
 layoutValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_layout_geometry.py'),
 layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit'],
 fontPolicy:{basis:'design',families:['Arial']},
 verifyArtifactToolImport:true,
 receiptPath:path.join(buildDir,'actions-and-outcomes.validation.json'),
});
console.log(JSON.stringify({finalPath,result},null,2));
