<template>
<b-form @submit="submit">
    <h4>Detail</h4>
    <b-form-group label="Title *" horizontal>
        <b-form-input required v-model="pub.name" type="text" placeholder="Title of the paper"></b-form-input>
    </b-form-group>
    <b-form-group label="Description *" horizontal>
        <b-form-textarea v-model="pub.desc" :rows="3" placeholder="A short description (or subtitle) of this publication (please keep it under 500 characters.)" required></b-form-textarea>
        <b-alert :show="pub.desc.length > 700" variant="danger">Sub-title is too long. Please use the Detail section below for detailed description of this publication.</b-alert>
    </b-form-group>
    <b-form-group label="Detail" horizontal>
        <b-form-textarea v-model="pub.readme" :rows="10" placeholder="Enter detailed description for this publication and your project. Explain what other searchers can do with your data. You can enter chars / tables / katex(math equations) etc.."></b-form-textarea>
        <small class="text-muted">in <a href="https://help.github.com/articles/basic-writing-and-formatting-syntax/" target="_blank">markdown format</a></small>
    </b-form-group>
    <b-form-group label="Tags" horizontal>
        <select2 :options="oldtags" v-model="pub.tags" :multiple="true" :tags="true"></select2>
    </b-form-group>
    <b-form-group label="License *" horizontal>
        <b-form-select :options="licenses" required v-model="pub.license"/>
        <div style="margin-top:10px; margin-left: 10px; opacity: 0.8">
            <small>
                <license :id="pub.license"/>
            </small>
        </div>
    </b-form-group>
    <b-form-group label="Fundings" horizontal>
        <b-row v-for="(funding, idx) in pub.fundings" :key="idx" style="margin-bottom: 5px;">
            <b-col>
                <b-input-group prepend="Funder">
                    <b-form-select :options="['NSF', 'NIH', 'DOE', 'DOD']" required v-model="funding.funder"/>
                </b-input-group>
            </b-col>
            <b-col>
                <b-input-group prepend="ID">
                    <b-form-input type="text" required v-model="funding.id" placeholder=""/>
                </b-input-group>
            </b-col>
            <b-col cols="1">
                <div class="button" @click="remove_funder(idx)"><icon name="trash"/></div>
            </b-col>
        </b-row>
        <b-button type="button" @click="pub.fundings.push({})" size="sm"><icon name="plus"/> Add Funder</b-button>
    </b-form-group>
    <b-form-group label="Authors *" horizontal>
        <contactlist v-model="pub.authors"/>
    </b-form-group>
    <b-form-group label="Contributors" horizontal>
        <contactlist v-model="pub.contributors"></contactlist>
    </b-form-group>
    <b-form-group label="Releases" horizontal>
        <p>
            <small opacity="0.7">Release is where you can list datasets that you'd like to publish.</small>
        </p>
        <transition-group name="slideDown">
            <b-card v-for="(release, idx) in pub.releases" v-if="!release.removed" :key="release._id||idx" style="margin-bottom: 5px;">
                <b-row>
                    <b-col>
                        <b-input-group prepend="Release Name">
                            <b-form-input :disabled="!!release._id" type="text" required v-model="release.name" placeholder=""/>
                        </b-input-group>
                    </b-col>
                    <b-col>
                        <b-input-group prepend="Release Date">
                            <b-form-input :disabled="!!release._id" type="date" required v-model="release._create_date" placeholder=""/>
                        </b-input-group>
                    </b-col>
                    <b-col sm="1">
                        <div class="button" @click="release.removed = true"><icon name="trash"/></div>
                    </b-col>
                </b-row>
                <br>
                <p v-for="(set, idx) in release.sets">
                    <datatypetag :datatype="set.datatype" :tags="set.datatype_tags"/> 
                    <span v-if="set.subjects && set.subjects.length == 0">{{set.count}} datasets ({{set.size|filesize}})</span>
                    <span v-if="set.add" @click="remove_set(release, idx)" style="opacity: 0.5;">
                        <icon name="trash" scale="0.9"/>
                    </span>
                </p>
                <b-button v-if="!release._id" type="button" variant="outline-success" @click="add_datasets(release)" size="sm"><icon name="plus"/> Add Datasets</b-button>
            </b-card>
        </transition-group>
        <b-button type="button" @click="new_release" size="sm"><icon name="plus"/> Add New Release</b-button>
    </b-form-group>

    <br>
    <br>
    <br>
    <br>
    <br>
    <div class="page-footer">
        <b-button type="button" @click="cancel">Cancel</b-button>
        <b-button type="submit" variant="primary">Submit</b-button>
    </div>
</b-form>
</template>

<script>

import select2 from '@/components/select2'
import license from '@/components/license'
import contactlist from '@/components/contactlist'
import datatypetag from '@/components/datatypetag'

const async = require("async");

export default {
    components: { 
        select2, license, contactlist, datatypetag,
    },

    props: {
        project: { type: Object },
        pub: { type: Object },
    },

    data () {
        return {
            licenses: [
                {value: 'ccby.40', text: 'CC BY 4.0'},
                {value: 'ccbysa.30', text: 'CC BY-SA 3.0'},
                {value: 'cc0', text: 'CC0'},
                {value: 'pddl', text: 'PDDL'},
                {value: 'odc.by', text: 'ODC BY 1.0'},
            ],
            oldtags: null,
        }
    },

    mounted() {
        //select2 needs option set to show existing tags.. so we copy my own tags and use it as options.. stupid select2
        this.oldtags = Object.assign(this.pub.tags);

        if(!this.pub.releases) this.$set(this.pub, 'releases', []);
        this.pub.releases.forEach(release=>{
            release._create_date = (new Date(release.create_date)).toISOString().split('T')[0];
            if(!release.sets) release.sets = [];

            //load list of datasets published (grouped by subject/datatype/tags)
            let sets = {};
            this.$http.get('dataset/inventory', { params: {
                find: JSON.stringify({ 
                    //removed: false,
                    project: this.project._id,
                    publications: release._id,
                }),
            }})
            .then(res=>{
                //regroup to datatype/tags (we don't need to split by subject)
                let datatype_ids = [];
                res.data.forEach(rec=>{
                    let subject = rec._id.subject;
                    let datatype = rec._id.datatype;
                    if(!datatype_ids.includes(datatype)) datatype_ids.push(datatype);
                    let datatype_tags = rec._id.datatype_tags;

                    let key = datatype + "."+JSON.stringify(rec._id.datatype_tags);
                    if(!sets[key]) sets[key] = {datatype, datatype_tags, size: rec.size, count: rec.count}; 
                    else {
                        sets[key].size += rec.size;
                        sets[key].count += rec.count;
                    }
                });

                //load datatype details
                return this.$http.get('datatype', {params: {
                    find: JSON.stringify({_id: {$in: datatype_ids}}),
                }});
            }) 
            .then(res=>{
                let datatypes = {};
                res.data.datatypes.forEach((d)=>{
                    datatypes[d._id] = d;
                });

                //lookup datatype and "populate" datatypes
                for(var key in sets) {
                    sets[key].datatype = datatypes[sets[key].datatype];
                } 
                release.sets = Object.values(sets);
                this.$forceUpdate();
            }).catch(console.error);
        });
    },

    methods: {
        cancel() {
            console.log("cancel pubform");
            this.$emit("cancel");
        },

        submit(evt) {
            evt.preventDefault();
            
            //reset release create_date
            this.pub.releases.forEach(release=>{
                release.create_date = new Date(release._create_date);
            });

            this.$emit("submit", this.pub);
        },

        remove_funder(idx) {
            console.log("removing", idx);
            this.pub.fundings.splice(idx, 1);            
            console.log(this.pub.fundings);
        },

        new_release() {
            this.pub.releases.push({
                _create_date: (new Date()).toISOString().split('T')[0],
                name: (this.pub.releases.length+1).toString(),
                removed: false,
                sets: [],
            })
        },

        add_datasets(release) {
            this.$root.$emit("datatypeselecter.open", {project: this.project, /*selected: release.sets*/});
            this.$root.$on("datatypeselecter.submit", sets=>{
                this.$root.$off("datatypeselecter.submit");

                //set add flag to true to signal API server to publish these new datasets
                sets.forEach(set=>{ set.add = true; }); 

                release.sets = release.sets.concat(sets); //TODO - dedupe this
                this.$forceUpdate(); //to show new sets..
            });
        },

        remove_set(release, idx) {
            release.sets.splice(idx, 1);
            this.$forceUpdate();
        }
    }
}
</script>

<style scoped>
h4 {
color: #999;
border-bottom: 1px solid #eee;
padding-bottom: 10px;
margin-bottom: 15px;
}
</style>
