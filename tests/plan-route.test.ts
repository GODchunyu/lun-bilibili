import assert from 'node:assert/strict';
import test from 'node:test';
import { planRoute,planHref,planVideo } from '../web/plan-route.js';
test('U07: direct plan URLs retain selection independently from list page and filter',()=>{for(const state of ['uncertain','manual_review','waiting_template','']){const url=planHref(state,901,100);assert.deepEqual(planRoute(url.split('?')[1]),{filter:state,selected:901,offset:100});}assert.deepEqual(planRoute('?state=uncertain&planId=901'),{filter:'uncertain',selected:901,offset:0});});
test('U08/U13: invalid route values and video JSON have safe visible fallbacks',()=>{assert.deepEqual(planRoute('?state=invalid&planId=-1&offset=-1'),{filter:'',selected:undefined,offset:0});assert.equal(planRoute('?planId=1.5').selected,undefined);assert.deepEqual(planVideo('bad json','BV1234567890'),{title:'BV1234567890',author:''});});
