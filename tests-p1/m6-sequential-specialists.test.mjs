import test from 'node:test';
import assert from 'node:assert/strict';
import {runSequentialSpecialists} from '../services/local-specialists.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('specialists run sequentially, persist before the next starts, and aggregate results', async () => {
  let active = 0;
  let maxActive = 0;
  const events = [];
  const persisted = [];
  const specialists = ['source-review', 'execution-review'].map((id) => ({
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
    'start:source-review','stop:source-review','persist:source-review',
    'start:execution-review','stop:execution-review','persist:execution-review',
  ]);
  assert.deepEqual(persisted, [['source-review'], ['source-review','execution-review']]);
  assert.equal(result.status, 'Completed');
  assert.equal(result.modelCalls, 2);
  assert.deepEqual(result.evidenceRefs, ['ev:source-review','ev:execution-review']);
});

test('a failed specialist becomes Incomplete without hiding later results', async () => {
  const result = await runSequentialSpecialists({
    specialists: [
      {id:'source-review', run: async () => { throw new Error('provider unavailable'); }},
      {id:'execution-review', run: async () => ({status:'Completed', findings:[], evidenceRefs:['ev:execution']})},
    ],
    maxSpecialists: 2,
    maxModelCalls: 1,
    persist: async () => {},
  });
  assert.equal(result.status, 'Incomplete');
  assert.equal(result.results[0].status, 'Incomplete');
  assert.match(result.results[0].error, /provider unavailable/);
  assert.equal(result.results[1].status, 'Completed');
});

test('duplicate specialists and model-call overflow are blocked', async () => {
  await assert.rejects(
    runSequentialSpecialists({specialists:[{id:'same',run:async()=>({status:'Completed'})},{id:'same',run:async()=>({status:'Completed'})}],persist:async()=>{}}),
    /duplicate specialist/i,
  );
  const result = await runSequentialSpecialists({
    specialists:[{id:'source-review',run:async({callModel})=>{
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
