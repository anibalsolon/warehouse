<template>
<div>
    <div class="page-content">
        <div v-if="!resource" class="loading">Loading ...</div>
        <div v-else>
            <div class="header header-sticky">
                <b-container  style="position: relative;">
                    <!--
                    <div @click="back()" class="button button-page">
                        <icon name="angle-left" scale="1.5"/>
                    </div>
                    -->
                    <div style="float: right; margin-left: 20px; margin-bottom: 20px;">
                        <b-btn size="sm" @click="test" variant="success" v-if="resource._canedit && !testing" title="Test">Test</b-btn>
                        <b-btn size="sm" v-if="testing" title="Test" disabled><icon name="cog" :spin="true"/> Testing ... </b-btn>
                        <b-btn @click="edit" v-if="resource._canedit" variant="secondary" size="sm"><icon name="edit"/> Edit</b-btn>
                    </div>
                    <h5>
                        <b-badge v-if="!resource.active">Inactive</b-badge>
                        <b-badge v-if="!resource.gids || resource.gids.length == 0" variant="secondary" title="Private resource"><icon name="lock" scale="0.9"/></b-badge>
                        {{resource.name}}
                    </h5>
                    <p style="opacity: 0.6">{{resource.config.desc}}</p>

                    <p>
                        <statustag :status="resource.status" style="font-size: 150%"/>
                        <span style="padding-left: 15px; opacity: 0.3; font-size: 85%;">
                            Tested <timeago :datetime="resource.status_update" :auto-update="1"/>
                        </span>
                        <pre v-if="resource.status != 'ok'" style="max-height: 300px; overflow: auto; color: #dc3545">{{resource.status_msg}}</pre>
                    </p>
                </b-container>
            </div>
            <br>
            <b-container>
                <div class="card">
                    <div style="padding: 20px">
                        <span class="form-header">Apps</span>
                        <small>The following services are enabled to run on this resource</small>
                    </div>
                    <table class="table table-sm">
                        <thead>
                            <tr style="background-color: #eee;">
                                <th style="padding-left: 20px">Github repos <small>(priority score)</small></th>
                                <th style="padding-right: 20px;">Total Requests <small style="float: right">success rate</small></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="service in resource.config.services" :key="service.name">
                                <td style="padding-left: 20px">
                                    {{service.name}}
                                    <small>({{service.score}})</small>
                                </td>
                                <td style="padding-right: 20px;">
                                    <div v-if="resource.stats && resource.stats.services && resource.stats.services[service.name]">
                                        <span>{{resource.stats.services[service.name].running}}</span>
                                        <!--
                                        <stateprogress :states="{'finished': resource.stats.services[service.name].finished, 'failed': resource.stats.services[service.name].failed}" style="margin-right: 125px;"/>
                                        -->
                                        <small style="float: right;">{{success_rate(service.name)}}</small>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div class="card" style="padding: 20px">
                    <b-row>
                        <b-col cols="2">
                            <span class="form-header">Login Host</span>
                        </b-col>
                        <b-col>
                            <p class="">
                                <pre>{{resource.config.username}}@{{resource.config.hostname}}</pre>
                            </p>
                        </b-col>
                    </b-row>

                    <b-row>
                        <b-col cols="2">
                            <span class="form-header">Workdir</span>
                        </b-col>
                        <b-col>
                            <p class="">
                                <pre>{{resource.config.workdir}}</pre>
                            </p>
                        </b-col>
                    </b-row>

                    <b-row v-if="resource.config.io_hostname">
                        <b-col cols="2">
                            <span class="form-header">IO Hostname</span>
                        </b-col>
                        <b-col>
                            <p>
                                <pre class="">{{resource.config.io_hostname}}</pre> 
                                <small>Optional hostname used to transfer data in and out of this resource</small>
                            </p>
                        </b-col>
                    </b-row>
                    <b-row>
                        <b-col cols="2">
                            <span class="form-header">Owner</span>
                        </b-col>
                        <b-col>
                            <p>
                                <contact :id="resource.user_id"/>
                            </p>
                        </b-col>
                    </b-row>

                    <b-row v-if="resource.gids && resource.gids.length > 0">
                        <b-col cols="2">
                            <span class="form-header">Groups</span>
                        </b-col>
                        <b-col>
                            <div class="">
                                <tags :tags="resource.gids"/><br>
                            </div>
                            <p>
                                <small>Group ID that this resource is shared with</small>
                            </p>
                        </b-col>
                    </b-row>

                    <b-row>
                        <b-col cols="2">
                            <span class="form-header">Max Task</span>
                        </b-col>
                        <b-col>
                            <p style="opacity: 0.6;">
                               Up to <b>{{resource.config.maxtask}}</b> concurrent tasks will be submitted on this resource
                            </p>
                        </b-col>
                    </b-row>
                    <b-row v-if="resource.envs && Object.keys(resource.envs).length > 0">
                        <b-col cols="2">
                            <span class="form-header">ENVs</span>
                        </b-col>
                        <b-col>
                            <p class="">
                                <pre>{{resource.envs}}</pre>
                            </p>
                        </b-col>
                    </b-row>

                    <b-row v-if="resource.citation">
                        <b-col cols="2">
                            <span class="form-header">Citation</span>
                        </b-col>
                        <b-col>
                            <p class="" style="opacity: 0.8;">
                                <i>{{resource.citation}}</i>
                            </p>
                        </b-col>
                    </b-row>
                </div><!--card-->

                <div class="card">
                    <div style="padding: 20px">
                        <span class="form-header">Recent Jobs</span>
                    </div>
                    <Plotly v-if="usage_data" :data="usage_data" :layout="usage_layout" style="background-color: #f6f6f6;"/>
                    <table class="table table-sm">
                        <thead>
                            <tr style="background-color: #eee;">
                                <th style="padding-left: 20px; width: 100px;">Group</th>
                                <th>Status</th>
                                <th>Submitter</th>
                                <th>Date</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tr v-for="task in tasks" :key="task._id">
                            <td style="width: 70px; padding-left: 20px;">
                                <small><icon name="id-badge"/> {{task._group_id}}</small><br>
                            </td>
                            <td>
                                <span class="status-color" :class="task.status" style="padding: 3px;" :title="task.status">
                                    <statusicon :status="task.status" /> 
                                    <!--<span style="text-transform: uppercase;" >{{task.status}}</span>-->
                                </span>
                                {{task.service}} <b-badge>{{task.service_branch}}</b-badge><br>
                                <small style="word-break: break-word;">{{task.status_msg}}</small>
                                <small style="font-size: 70%">{{task._id}}</small>
                            </td>
                            <td>
                                <contact :id="task.user_id" size="small"/>
                            </td>
                            <td>
                                <small>
                                    <time>Requested <timeago :datetime="task.request_date" :auto-update="1"/></time>
                                </small>
                            </td>
                            <td>
                                <small v-if="task.status == 'requested'">
                                    <time v-if="task.start_date">Started <timeago :datetime="task.start_date" :auto-update="1"/></time>
                                </small>
                                <small v-else-if="task.status == 'running'"><time>Started <timeago :datetime="task.start_date" :auto-update="1"/></time></small>
                                <small v-else-if="task.status == 'running_sync'"><time>Started <timeago :datetime="task.start_date" :auto-update="1"/></time></small>
                                <small v-else-if="task.status == 'finished'"><time>Finished <timeago :datetime="task.finish_date" :auto-update="1"/></time></small>
                                <small v-else-if="task.status == 'failed'"><time>Failed <timeago :datetime="task.fail_date" :auto-update="1"/></time></small>
                            </td>
                        </tr>
                    </table>
                    <p style="padding-left: 20px; opacity: 0.7; font-size: 80%;">Only showing up to 30 most recent jobs</p>

               </div><!--card / recentjobs-->

               <div class="card" v-if="projects" style="padding: 20px">
                    <span class="form-header">Projects</span>
                    <p>
                        <small>This resource has been used to analyze datasets on the following projects (only showing >10 hours of usage)</small>
                    </p>
                    <div>
                        <b-row style="margin-bottom: 8px; opacity: 0.7; background-color: #eee; padding: 5px;">
                            <b-col cols="6">Project Name</b-col>
                            <b-col>Admin </b-col>
                            <b-col>Total Walltime</b-col>
                        </b-row>

                        <div v-for="project in resource.stats.projects" :key="project._id">
                            <b-row v-if="projects[project._id] && project.total_walltime > 3600*1000*10" style="border-top: 1px solid #eee; padding: 2px 0px">
                                <b-col cols="6">
                                    <b>{{projects[project._id].name}}</b><br>
                                    <small>{{projects[project._id].desc}}</small>
                                </b-col>
                                <b-col>
                                    <small><contact v-for="id in projects[project._id].admins" size="small" :key="id" :id="id"/></small>
                                </b-col>
                                <b-col>
                                    {{(project.total_walltime/(1000*60*60)).toFixed(1)}} hours <small>({{project.count}} jobs)</small>
                                </b-col>
                            </b-row>
                        </div>
                    </div>
                </div><!--card-->

               <hr>
                <p style="opacity: 0.7;">
                    <icon name="calendar"/> Created on {{new Date(resource.create_date).toLocaleDateString()}}
                </p>
                <p style="opacity: 0.7;">
                    <icon name="calendar"/> Updated on {{new Date(resource.update_date).toLocaleDateString()}}
                </p>
                <p style="opacity: 0.7;">
                    <icon name="calendar"/> Last OK date {{new Date(resource.lastok_date).toLocaleDateString()}}
                </p>

                <div v-if="config.debug">
                    <pre>{{resource}}</pre>
                    <pre>{{usage_data}}</pre>
                </div>
            </b-container>
        </div>
    </div>
</div>
</template>

<script>

import Vue from 'vue'
import Router from 'vue-router'
import {Plotly} from 'vue-plotly'

import pageheader from '@/components/pageheader'
import contact from '@/components/contact'
import app from '@/components/app'
import tags from '@/components/tags'
import statustag from '@/components/statustag'
import statusicon from '@/components/statusicon'
import stateprogress from '@/components/stateprogress'

export default {
    components: { 
        pageheader, app, contact, tags, statustag, statusicon, stateprogress, Plotly,
    },

    data () {
        return {
            resource: null, 
            //groups: null,
            tasks: [], //currently running tasks

            //report: null,
            projects: null, //list of all projects and some basic info (only admin can load this)
            usage_data: null, 
            usage_layout: null, 

            testing: false,
            config: Vue.config,
        }
    },

    computed: {
    },

    mounted() {
        this.load();
    },

    methods: {
        success_rate(service) {
            if(!service) return null;
            let stat = this.resource.stats.services[service];
            if(!stat || !stat.finished || !stat.failed) return null;
            let p = stat.finished / (stat.finished + stat.failed);
            return (p*100).toFixed(1)+ "%";
        },
        load() {
            console.log("loading resource:"+this.$route.params.id);
            this.$http.get(Vue.config.amaretti_api+'/resource', {params: {
                find: JSON.stringify({
                    _id: this.$route.params.id,
                }),
            }}).then(res=>{
                this.resource = res.data.resources[0];
                if(!this.resource) alert("no such resource");
                this.resource.config.services.sort((a,b)=>{
                    let a_stats = this.resource.stats.services[a.name];
                    let b_stats = this.resource.stats.services[b.name];
                    if(a_stats && b_stats) {
                        if(a_stats.running < b_stats.running) return 1;
                        if(a_stats.running > b_stats.running) return -1;
                    } else {
                        //if not stats, sort by name
                        if(a.name < b.name) return -1;
                        if(a.name > b.name) return 1;
                    }
                    return 0;
                });

                if(Vue.config.has_role("admin")) {
                    if(!this.resource.stats.projects) return;
                    let group_ids = this.resource.stats.projects.map(p=>p._id);
                    this.$http.get('/project/', {params: {
                        find: JSON.stringify({
                            group_id: {$in: group_ids},
                        }),
                        select: 'name desc group_id admins',
                        admin: true, //return all that matches (requires admin token)
                        limit: 0,
                    }}).then(res=>{
                        this.projects = {};
                        res.data.projects.forEach(project=>{
                            this.projects[project.group_id] = project;
                        });
                    }).catch(console.error);
                }
            }).catch(console.error);

            this.$http.get(Vue.config.amaretti_api+'/resource/tasks/'+this.$route.params.id).then(res=>{
                this.tasks = res.data.recent;
            }).catch(console.error);

            this.$http.get(Vue.config.amaretti_api+'/resource/usage/'+this.$route.params.id).then(res=>{
                let x = [];
                let y = [];
                res.data.forEach(rec=>{
                    x.push(new Date(rec[0]*1000)); //time
                    y.push(rec[1]); //value
                });
                let line = {
                    width: 1,
                    shape: 'spline',
                };
                this.usage_data = [{x, y, type: 'scatter', mode: 'lines', line, fill: 'tozeroy', fillcolor: '#07f2'}];
                this.usage_layout = {
                    height: 200,
                    margin: {
                        t: 20, //top
                        b: 35, //bottom
                        r: 20, //right
                        l: 30,
                    },
                    xaxis: {
                        //title: 'Running Jobs',
                        //showgrid: false,
                        //linecolor: '#fff',
                        zeroline: false,
                        tickfont: {
                            color: 'gray',
                        },
                    },
                    yaxis: {
                        //title: 'Running Jobs',
                        zeroline: false,
                        tickfont: {
                            color: 'gray',
                        },
                    },
                    font: Vue.config.plotly.font,
                    plot_bgcolor: "#fff0",
                    paper_bgcolor: "#fff0",
                };
            }).catch(console.error);
        },

        back() {
            if(window.history.length > 1) this.$router.go(-1);
            else this.$router.push('/resources');
        },

        test() {
            if(this.testing) return; //already testing
            this.testing = true;
            this.$http.put(Vue.config.amaretti_api+'/resource/test/'+this.$route.params.id).then(res=>{
                this.resource.status = res.data.status;
                this.resource.status_msg = res.data.message.trim(); 
                if(res.data.status == "ok") this.$notify({type: "success", text: "Successfully tested!"});
                else this.$notify({type: "error", text: "Resource test failed"});
                this.resource.status_update = new Date();
                this.testing = false;
            }).catch(err=>{
                this.testing = false;
                this.resource.status_update = new Date();
                this.$notify({type: "error", text: err.response.data.message});
            });
         },

        edit() {
            //this.editing = true;
            this.$router.push('/resource/'+this.resource._id+'/edit');
        },
    },

    watch: {
        '$route': function() {
            load();
        },
    }
}
</script>

<style scoped>
.page-content {
top: 0px;
background-color: #f9f9f9;
}
.page-content h2 {
margin-bottom: 0px;
padding: 10px 0px;
font-size: 20pt;
}
.page-content h3 {
background-color: white;
color: gray;
padding: 20px;
margin-bottom: 0px;
}
.page-content h4 {
padding: 15px 20px;
background-color: white;
opacity: 0.8;
color: #999;
font-size: 17pt;
font-weight: bold;
}
.header {
padding: 10px;
background-color: white;
border-bottom: 1px solid #eee;
}
.header-sticky {
position: sticky;
top: 0px;
z-index: 1;
box-shadow: 0 0 1px #ccc;
}
code.json {
background-color: white;
}
.form-action {
text-align: right;
position: fixed;
bottom:0;
right:0;
left:50px;
background-color: rgba(100,100,100,0.4);
padding: 10px;
}
.loading {
padding: 50px;
font-size: 20pt;
opacity: 0.5;
}
.box {
background-color: white;
padding: 10px;
}
.resource {
background-color: white;
padding: 10px;
}
.button-page {
position: absolute;
left: -30px;
z-index: 1;
opacity: 0.6;
}
.card {
    margin-bottom: 20px;
    border: none;
}
.table th {
border: none;
font-size: 90%;
padding-left: 0px;
opacity: 0.7;
}
</style>

