import test from 'node:test';
import assert from 'node:assert/strict';
import {runSequentialSpecialists} from '../services/local-specialists.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('specialists run sequentially, persist before the next starts, and aggregate results', async () => {
  let active = 0;
  let maxActive = 0;
  const events = [];
  const persisted = [];
  const specialists = ['security','second-stub'].map((id) => ({
    id,
    async run({callModel}) {
      events.push(`start:${id}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const model = await callModel(async () => ({provider:'stub', model:'stub'}));
      await delay(5);
      active -= 1;
      events.push(`stop:${id}`);
      return {status:'Completed', findings:[{title:id}], evidenceRefs:[`ev:${id}`], model};
    },
  }));
  const result = await runSequentialSpecialists({
    specialists,
    maxSpecialists: 2,
    maxModelCalls: 2,
    persist: async (snapshot) => {
      persisted.push(snapshot.results.map((item) => item.id));
      events.push(`persist:${snapshot.results.at(-1).id}`);
    },
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(events, [
    'start:security','stop:security','persist:security',
    'start:second-stub','stop:second-stub','persist:second-stub',
  ]);
  assert.deepEqual(persisted, [['security'], ['security','second-stub']]);
  assert.equal(result.status, 'Completed');
  assert.equal(result.modelCalls, 2);
});

test('one specialist cannot create concurrent provider calls through Promise.all', async () => {
  let active = 0;
  let peak = 0;
  const delayedProvider = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(20);
    active -= 1;
    return {provider:'stub',model:'stub'};
  };
  const result = await runSequentialSpecialists({
    specialists:[{
      id:'security',
      async run({callModel}) {
        await Promise.all([callModel(delayedProvider),callModel(delayedProvider)]);
        return {status:'Completed',findings:[],evidenceRefs:[]};
      },
    }],
    maxSpecialists:1,
    maxModelCalls:2,
    persist:async()=>{},
  });
  assert.equal(result.status,'Completed');
  assert.equal(result.modelCalls,2);
  assert.equal(peak,1);
});

test('a failed specialist becomes Incomplete and is persisted', async () => {
  const snapshots=[];
  const result = await runSequentialSpecialists({
    specialists: [{id:'security', run: async () => { throw new Error('provider unavailable'); }}],
    maxSpecialists:1,
    maxModelCalls:1,
    persist: async (snapshot) => snapshots.push(snapshot),
  });
  assert.equal(result.status, 'Incomplete');
  assert.equal(result.results[0].status, 'Incomplete');
  assert.match(result.results[0].error, /provider unavailable/);
  assert.equal(snapshots.length,1);
  assert.equal(snapshots[0].results[0].status,'Incomplete');
});

test('duplicate specialists and model-call overflow are blocked', async () => {
  await assert.rejects(
    runSequentialSpecialists({specialists:[{id:'same',run:async()=>({status:'Completed'})},{id:'same',run:async()=>({status:'Completed'})}],maxSpecialists:2,persist:async()=>{}}),
    /duplicate specialist/i,
  );
  const result = await runSequentialSpecialists({
    specialists:[{id:'security',run:async({callModel})=>{
      await callModel(async()=>1);
      await callModel(async()=>2);
      return {status:'Completed'};
    }}],
    maxModelCalls:1,
    persist:async()=>{},
  });
  assert.equal(result.status,'Incomplete');
  assert.match(result.results[0].error,/model call limit/i);
});
