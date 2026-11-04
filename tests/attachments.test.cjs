const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function start() {
  const pet = {hidden:false,dataset:{kind:'ghost',accessory:'crown'}};
  const accessory = {style:{}};
  const clip = {hidden:false,style:{}};
  const sprite = {};
  let style = {backgroundPositionX:'0px',backgroundPositionY:'0px'};
  let next;
  const context = vm.createContext({
    document:{hidden:false,querySelector:selector=>({'#pet':pet,'#pet .sprite':sprite,'#accessory':accessory,'#clip':clip})[selector],addEventListener:()=>{}},
    MutationObserver:class {observe(){}},getComputedStyle:()=>style,
    requestAnimationFrame:fn=>{next=fn;return 1;},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../art/attachments.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../dist/attachments.js'),'utf8'),context);
  const frames = vm.runInContext('petAttachmentFrames',context);
  return {pet,accessory,clip,frames,
    show:(kind,row,frame,selected='crown')=>{
      pet.dataset.kind=kind;pet.dataset.accessory=selected;
      style={backgroundPositionX:frame*-128+'px',backgroundPositionY:row*-128+'px'};
      next();
    },
  };
}

test('generated attachment points cover every character, sprite row, and frame',()=>{
  const app=start();
  assert.equal(Object.keys(app.frames).length,9);
  for(const rows of Object.values(app.frames)) {
    assert.equal(rows.length,20);
    for(const frames of rows) {
      assert.equal(frames.length,6);
      for(const anchors of frames) {
        assert.equal(anchors.length,6);
        assert.ok(anchors.every(Number.isFinite));
      }
    }
  }
});

test('headwear and Moonclip follow the ghost float rather than staying fixed',()=>{
  const app=start();
  app.show('ghost',0,0);
  const crownY=parseFloat(app.accessory.style.top), clipY=parseFloat(app.clip.style.top);
  app.show('ghost',0,2);
  assert.equal(parseFloat(app.accessory.style.top)-crownY,-16);
  assert.equal(parseFloat(app.clip.style.top)-clipY,-16);
  assert.equal(app.accessory.style.visibility,'visible');
});

test('headwear follows dance motion while body accessories stay on the torso',()=>{
  const app=start();
  app.show('cat',5,0);
  const headX=app.accessory.style.left, headY=app.accessory.style.top;
  app.show('cat',5,3);
  assert.notEqual(app.accessory.style.left,headX);
  app.show('cat',5,1);
  assert.notEqual(app.accessory.style.top,headY);
  app.show('cat',5,0,'ribbon');
  const ribbon={...app.accessory.style};
  app.show('cat',5,3,'ribbon');
  assert.equal(app.accessory.style.left,ribbon.left);
  assert.equal(app.accessory.style.top,ribbon.top);
});

test('accessories track side-profile pickup poses and closed-eye music rows',()=>{
  const app=start();
  app.show('cat',8,0);
  assert.equal(app.accessory.style.left,'25px');
  app.show('cat',11,0);
  const top=parseFloat(app.accessory.style.top);
  app.show('cat',11,2);
  assert.equal(parseFloat(app.accessory.style.top)-top,12);
  app.show('cat',5,2);
  const dance=app.accessory.style.top;
  app.show('cat',16,2);
  assert.equal(app.accessory.style.top,dance);
});
