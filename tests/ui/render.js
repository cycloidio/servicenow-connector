/* Generates tests/ui/out/index.html from the widget sources (mock data). */
const fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..','..');
const W=path.join(ROOT,'servicenow','src','widgets');
const OUT=path.join(__dirname,'out');
fs.mkdirSync(OUT,{recursive:true});
function t(id){return fs.readFileSync(W+'/'+id+'/template.html','utf8').replace(/\$\{([^}]*)\}/g,'$1');}
function c(id){return fs.readFileSync(W+'/'+id+'/client_script.js','utf8');}
function css(id){return fs.readFileSync(W+'/'+id+'/style.css','utf8');}
const catalogData={title:'Cycloid services',configured:true,openInNewTab:true,
 items:[{sys_id:'1',name:'AWS virtual machine',short_description:'An EC2 instance with monitoring and backups',stack_ref:'acme:stack-aws-vm',picture:'',initials:'AW'},
 {sys_id:'2',name:'Kubernetes app',short_description:'Deploy a Helm release on a shared cluster',stack_ref:'acme:stack-k8s-app',picture:'',initials:'KU'},
 {sys_id:'3',name:'PostgreSQL database',short_description:'Managed Postgres with daily snapshots',stack_ref:'acme:stack-pg',picture:'',initials:'PO'},
 {sys_id:'4',name:'Static website',short_description:'S3 + CloudFront website',stack_ref:'acme:stack-web',picture:'',initials:'ST'}],
 projects:[{sys_id:'p1',name:'Web shop',canonical:'webshop'},{sys_id:'p2',name:'Data platform',canonical:'data'}],
 environments:[{sys_id:'e1',name:'Staging',project:'p1'},{sys_id:'e2',name:'Production',project:'p1'},{sys_id:'e3',name:'dev',project:'p2'}]};
const depData={title:'My Cycloid deployments',items:[
 {sys_id:'d1',stack:'AWS virtual machine',project:'Web shop',environment:'Staging',status:'Running',status_message:'Job terraform-apply is running (build #1).',active:true,ritm_number:'RITM0010012',ritm_sys_id:'r1',requested_at:'2026-10-21 11:02:10',component_name:'Shop VM',create_url:'#',component_url:'#',build_url:'#'},
 {sys_id:'d2',stack:'Kubernetes app',project:'Data platform',environment:'dev',status:'Awaiting component',status_message:'Waiting for the component to be created in Cycloid.',active:true,ritm_number:'RITM0010013',ritm_sys_id:'r2',requested_at:'2026-10-21 11:20:44',component_name:'',create_url:'#',component_url:'',build_url:''},
 {sys_id:'d3',stack:'PostgreSQL database',project:'Web shop',environment:'Production',status:'Succeeded',status_message:'Job deploy succeeded (build #4).',active:false,ritm_number:'RITM0010009',ritm_sys_id:'r3',requested_at:'2026-10-20 16:41:03',component_name:'orders-db',create_url:'#',component_url:'#',build_url:'#'}]};
const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="../../../node_modules/bootstrap/dist/css/bootstrap.min.css"><link rel="stylesheet" href="../../../node_modules/font-awesome/css/font-awesome.min.css">
<style>body{background:#f6f7f8;padding-top:24px}${css('cycloid_catalog')}${css('cycloid_my_deployments')}</style>
<script src="../../../node_modules/angular/angular.min.js"></script></head>
<body ng-app="sp"><div class="container"><div class="row"><div class="col-md-8 col-sm-12 col-xs-12"><w-catalog></w-catalog></div><div class="col-md-4 col-sm-12 col-xs-12"><w-deps></w-deps></div></div></div>
<script>
window.__orders=[];
function make(clientCode,data,serverGet){var api={};(new Function('api',clientCode))(api);
 return ['$scope','$injector','$q','$window',function($scope,$injector,$q,$window){this.data=data;var self=this;
 this.server={get:function(i){window.__orders.push(i);return $q.resolve({data:{result:serverGet(i)}});},refresh:function(){window.__refreshed=(window.__refreshed||0)+1;return $q.resolve();}};
 $injector.invoke(api.controller,this,{$scope:$scope,$window:$window});}];}
angular.module('sp',[])
.directive('wCatalog',function(){return{scope:{},controllerAs:'c',template:${JSON.stringify(t('cycloid_catalog'))},controller:make(${JSON.stringify(c('cycloid_catalog'))},${JSON.stringify(catalogData)},function(i){return i.environment==='e2'?{error:'The request could not be created.'}:{create_url:'https://console.us.cycloid.io/organizations/acme/projects/webshop/environments/staging/components/create?canonical=stack-aws-vm',ritm_number:'RITM0010014'};})};})
.directive('wDeps',function(){return{scope:{},controllerAs:'c',template:${JSON.stringify(t('cycloid_my_deployments'))},controller:make(${JSON.stringify(c('cycloid_my_deployments'))},${JSON.stringify(depData)},null)};});
window.open=function(){window.__opened={location:{},close:function(){window.__closed=true}};return window.__opened;};
</script></body></html>`;
fs.writeFileSync(path.join(OUT,'index.html'),html);
