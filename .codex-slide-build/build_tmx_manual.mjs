import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

const skillDir = 'C:/Users/User/.codex/plugins/cache/openai-primary-runtime/presentations/26.904.11930/skills/presentations';
const workspaceDir = 'D:/All Work/TM-X React';
const buildDir = path.join(workspaceDir, '.codex-slide-build');
const outputDir = path.join(workspaceDir, 'output');
const finalPath = path.join(outputDir, 'TM-X_Web_User_Manual_Template.pptx');
const pythonExecutable = 'C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const { finalizePresentation } = await import(pathToFileURL(path.join(skillDir, 'container_tools/artifact_tool_utils.mjs')).href);

await fs.mkdir(buildDir, {recursive:true});
await fs.mkdir(outputDir, {recursive:true});

const ppt = Presentation.create({slideSize:{width:1280,height:720}});
const C = {navy:'#102D4B', blue:'#1784C7', pale:'#EFF6FB', text:'#19364F', muted:'#5C7488', line:'#BED5E7', white:'#FFFFFF', aqua:'#64CAE3'};
const font='Tahoma';
function box(slide,x,y,w,h,fill='none',stroke='none',sw=0){
  return slide.shapes.add({geometry:'rect',position:{left:x,top:y,width:w,height:h},fill,
    line:{fill:stroke,width:sw}});
}
function txt(slide,value,x,y,w,h,size=24,color=C.text,bold=false,align='left'){
  const s=slide.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
  s.text=value; s.text.style={typeface:font,fontSize:size,color,bold,alignment:align,verticalAlignment:'middle',autoFit:'none',wrap:true};
  return s;
}
function base(title,num){
  const s=ppt.slides.add(); s.background.fill=C.white;
  box(s,0,0,1280,13,C.blue);
  txt(s,title,68,47,1120,60,38,C.navy,true);
  box(s,68,123,1144,2,C.line);
  txt(s,'TM-X CONTROL SYSTEM',68,669,420,28,13,C.muted,true);
  txt(s,String(num).padStart(2,'0'),1150,664,60,34,16,C.muted,false,'right');
  return s;
}
function placeholder(s,label,x,y,w,h){
  box(s,x,y,w,h,C.pale,C.line,2);
  txt(s,'[ วางภาพหน้าจอ: '+label+' ]',x+32,y+h/2-34,w-64,68,23,C.muted,false,'center');
}
function step(s,n,label,y,x=782){
  txt(s,String(n).padStart(2,'0'),x,y,45,36,19,C.blue,true);
  txt(s,label,x+52,y-1,355,70,20,C.text,false);
}
function detail(title,num,imageLabel,items,note='[ เพิ่มคำอธิบายหรือข้อควรระวัง ]',reverse=false){
  const s=base(title,num);
  if(!reverse){
    placeholder(s,imageLabel,68,166,665,433);
    items.forEach((v,i)=>step(s,i+1,v,174+i*104));
    txt(s,note,782,594,416,53,17,C.muted);
  }else{
    items.forEach((v,i)=>step(s,i+1,v,174+i*104,68));
    txt(s,note,68,594,416,53,17,C.muted);
    placeholder(s,imageLabel,520,166,692,433);
  }
  return s;
}

// 1 — cover
{
  const s=ppt.slides.add(); s.background.fill=C.navy;
  box(s,0,0,18,720,C.aqua);
  txt(s,'คู่มือการใช้งานเว็บ',72,180,1080,80,50,C.white,true);
  txt(s,'TM-X Control System',72,272,1070,70,42,C.aqua,true);
  box(s,73,378,175,5,C.aqua);
  txt(s,'[ ชื่อหน่วยงาน / แผนก ]',72,424,900,46,23,C.white);
  txt(s,'เวอร์ชัน [ระบุ]    วันที่ [ระบุ]',72,612,900,42,18,'#BED6E7');
}
// 2 — navigation
{
  const s=base('ภาพรวมการใช้งาน',2);
  txt(s,'ลำดับงานหลัก',70,163,430,46,25,C.blue,true);
  const rows=[
    ['01','ตรวจสอบความพร้อม','สถานะเว็บและ Raspberry Pi'],
    ['02','เตรียมข้อมูลชิ้นงาน','Part Entry และคิวการวัด'],
    ['03','เริ่มวัดและดูผล','Session Control และ Live View'],
    ['04','ตรวจสอบข้อมูลย้อนหลัง','Measurements และรายงาน'],
    ['05','แก้ไขและส่งออก','Edit และ Export']
  ];
  rows.forEach((r,i)=>{
    const y=227+i*78;
    txt(s,r[0],72,y,60,44,21,C.blue,true);
    txt(s,r[1],145,y,390,44,23,C.navy,true);
    txt(s,r[2],585,y,570,44,20,C.muted);
    if(i<rows.length-1)box(s,70,y+58,1138,1,C.line);
  });
}
detail('ก่อนเริ่มใช้งาน',3,'หน้า Home และป้ายสถานะ',[ '[ ระบุ URL และวิธีเปิดเว็บ ]','[ ตรวจสอบสถานะ Station และ Raspberry Pi ]','[ อธิบายความหมายของสถานะที่พบ ]' ],'[ เพิ่มเงื่อนไขก่อนเริ่มวัด ]');
detail('เตรียมข้อมูลชิ้นงาน',4,'Part Entry',[ '[ เลือก IPM / New / Rework ]','[ กรอก Operator และข้อมูล ALPL ]','[ ตรวจสอบคิว แล้วกด Save ]' ],'[ เพิ่มตัวอย่างข้อมูลที่กรอกถูกต้อง ]',true);
detail('เริ่มและหยุดการวัด',5,'Session Control',[ '[ ตรวจสอบข้อมูลคิวก่อนกด Start ]','[ กด Start และดูสถานะ Running ]','[ กด Stop เมื่อสิ้นสุดงาน ]' ],'[ ระบุสิ่งที่เกิดขึ้นเมื่อหยุดกลางคัน ]');
detail('อ่านผลระหว่างวัด',6,'Live Telemetry และ Camera Preview',[ '[ อ่านค่า X / Y / Offset ]','[ ดูผล OK / NG และภาพล่าสุด ]','[ ติดตาม Progress ของ Session ]' ],'[ เพิ่มเกณฑ์ตัดสินผลหรือภาพตัวอย่าง ]',true);
detail('ค้นหาและดูผลย้อนหลัง',7,'ตาราง Measurements',[ '[ ค้นหาด้วย ALPL หรือวันที่ ]','[ เปิดรายการเพื่อดูรายละเอียด ]','[ ตรวจสอบข้อมูลและภาพประกอบ ]' ],'[ เพิ่มตัวอย่างการค้นหา ]');
detail('แก้ไขข้อมูล',8,'หน้า Edit',[ '[ เลือกตาราง Parts / Measurements ]','[ เพิ่มหรือแก้ไขข้อมูลที่ต้องการ ]','[ ตรวจสอบผลหลังบันทึก ]' ],'[ ระบุสิทธิ์ผู้แก้ไขและข้อควรระวัง ]',true);
detail('ส่งออกข้อมูล',9,'หน้า Export',[ '[ เลือก CSV / PDF / Excel ]','[ เลือก Template และกรองข้อมูล ]','[ ตรวจตัวอย่าง แล้วดาวน์โหลด ]' ],'[ เพิ่มชื่อไฟล์และตำแหน่งจัดเก็บ ]');
// 10 — troubleshooting
{
  const s=base('ปัญหาที่พบบ่อย',10);
  const items=[
    ['Raspberry Pi ไม่เชื่อมต่อ','[ วิธีตรวจสอบและติดต่อผู้ดูแล ]'],
    ['กด Start ไม่ได้','[ ตรวจสอบข้อมูลคิวและสถานะระบบ ]'],
    ['ไม่มีภาพหรือผลวัด','[ วิธีตรวจสอบเครื่องวัดและการรับข้อมูล ]'],
    ['Export แล้วไม่มีข้อมูล','[ ตรวจสอบตัวกรองและช่วงวันที่ ]']
  ];
  items.forEach((r,i)=>{
    let y=177+i*111;
    txt(s,String(i+1).padStart(2,'0'),72,y,55,43,22,C.blue,true);
    txt(s,r[0],144,y,450,46,24,C.navy,true);
    txt(s,r[1],604,y,570,64,20,C.muted);
    if(i<items.length-1)box(s,70,y+84,1137,1,C.line);
  });
}
// 11 — glossary and contact
{
  const s=base('คำศัพท์และผู้ติดต่อ',11);
  txt(s,'คำศัพท์ที่ใช้ในระบบ',70,170,460,50,26,C.blue,true);
  const terms=[['ALPL','[ ความหมาย ]'],['Session','[ ความหมาย ]'],['Tolerance','[ ความหมาย ]'],['OK / NG','[ ความหมาย ]']];
  terms.forEach((r,i)=>{
    let y=235+i*82;
    txt(s,r[0],72,y,220,47,23,C.navy,true);
    txt(s,r[1],295,y,350,47,20,C.muted);
    if(i<terms.length-1)box(s,70,y+61,575,1,C.line);
  });
  box(s,680,167,2,430,C.line);
  txt(s,'ผู้ดูแลระบบ',733,170,425,50,26,C.blue,true);
  txt(s,'ชื่อ: [ ระบุ ]\nแผนก: [ ระบุ ]\nโทรศัพท์ / อีเมล: [ ระบุ ]',733,243,427,240,23,C.text);
  txt(s,'เอกสารอ้างอิง: [ ระบุ ]',733,520,420,50,18,C.muted);
}

const candidatePath=path.join(buildDir,'candidate.pptx');
await (await PresentationFile.exportPptx(ppt)).save(candidatePath);
for(let i=0;i<ppt.slides.length;i++){
  const img=await ppt.export({slide:ppt.slides.getByIndex(i),format:'png',scale:0.75});
  await fs.writeFile(path.join(buildDir,`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await img.arrayBuffer()));
}
const result=await finalizePresentation({
  workspaceDir,candidatePath,finalPath,pythonExecutable,
  integrityValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit'],
  explicitTotalSlideCount:11,requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],
  fontPolicy:{basis:'design',families:[font]},
  verifyArtifactToolImport:true,
  receiptPath:path.join(buildDir,'validation.json')
});
console.log(JSON.stringify({finalPath,result},null,2));
