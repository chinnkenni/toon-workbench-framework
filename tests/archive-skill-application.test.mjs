import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveSkillApplication,CREATIVE_STAGE_LABELS} from '../frontend/src/archive-skill-application.mjs';

const episodeId='00000000-0000-4000-8000-000000000001';
test('only explicit skill-application records display use statements; existing archive records stay generic',()=>{
 for(const record of [null,{}, {stage:'review',title:'用了技能'}, {details:{skillId:'director-agent',application:'只提了技能名'}}, {details:{recordType:'review',applications:[{skillId:'director-agent',application:'说明'}]}}])assert.equal(archiveSkillApplication(record),null);
});
test('recorded scope, version, SHA and concrete applications remain exact and are labelled as agent reports',()=>{
 const record={details:{recordType:'skill-application',creativeStage:'storyboard',episodeId,verification:'agent-reported',applications:[{skillId:'vfx-compositing',version:1,sha256:'a'.repeat(64),application:'先固定示例道具与角色的遮挡关系。\n记录动作后示例角色的反应停顿。',outputRefs:['shot:017','media:registered-version','exports/review.mp4']}],note:'这次仅登记实际完成的分镜修改。'}},before=structuredClone(record),result=archiveSkillApplication(record);assert.equal(result.stageLabel,'分镜拆分');assert.equal(result.episodeId,episodeId);assert.equal(result.verification,'agent-reported');assert.equal(result.authorityLabel,'Agent 登记的应用说明');assert.match(result.qualityNote,/未独立核验/);assert.deepEqual(result.applications,record.details.applications);assert.equal(result.note,record.details.note);assert.deepEqual(record,before);
});
test('all fourteen creative stages are recognized without treating an archive storage stage as the creative scope',()=>{
 assert.equal(Object.keys(CREATIVE_STAGE_LABELS).length,14);for(const stage of Object.keys(CREATIVE_STAGE_LABELS)){const result=archiveSkillApplication({details:{recordType:'skill-application',creativeStage:stage}});assert.equal(result.stage,stage);assert.equal(result.stageLabel,CREATIVE_STAGE_LABELS[stage]);}const missing=archiveSkillApplication({stage:'review',details:{recordType:'skill-application',creativeStage:'not-a-stage',episodeId:'foreign-path',verification:'verified-by-backend'}});assert.equal(missing.stage,null);assert.equal(missing.stageLabel,'制作阶段未记录');assert.equal(missing.episodeId,null);assert.equal(missing.verification,null);assert.equal(missing.authorityLabel,'应用说明（登记来源未记录）');
});
test('malformed fields never invent used versions, verified SHA, applications or executable output links',()=>{
 const result=archiveSkillApplication({details:{recordType:'skill-application',applications:[null,{}, {skillId:'vfx-compositing',application:''}, {skillId:'build-web-apps:react-best-practices',application:'不能冒充创作包'}, {skillId:'vfx-compositing',version:'2',sha256:'invalid',application:'检查手袖遮挡。',outputRefs:[null,42,{},'', 'javascript:alert(1)', '<script>not markup</script>', '作品/017.wav']}]}});assert.equal(result.applications.length,1);assert.equal(result.applications[0].version,null);assert.equal(result.applications[0].sha256,null);assert.deepEqual(result.applications[0].outputRefs,['javascript:alert(1)','<script>not markup</script>','作品/017.wav']);assert.equal(Object.hasOwn(result.applications[0],'href'),false);assert.equal(Object.hasOwn(result.applications[0],'html'),false);assert.equal(archiveSkillApplication({details:{recordType:'skill-application',applications:{skillId:'vfx-compositing'}}}).applications.length,0);
});
