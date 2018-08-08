#!/usr/bin/env node

const async = require('async');
const request = require('request');
const fs = require('fs');
const tar = require('tar');
const winston = require('winston');
const ssh2 = require('ssh2');

const config = require('../../api/config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../../api/models');

console.log("connecting to db");
db.init(function(err) {
    if(err) throw err;
    run(err=>{
        if(err) throw err;
        logger.info("all done.. disconnecting");
        db.disconnect();
    });
});

function run(cb) {
    //find project that we need to set group_id
    db.Datasets.find({
        storage: "jetstream",
        removed: false, //don't care if its removed? (TODO remove it?)
    })
    .populate("project")
    .exec((err,datasets)=>{
        if(err) return cb(err);
        logger.debug("datasets stored in jetstream", datasets.length);
        async.eachSeries(datasets, (dataset, next_dataset)=>{
            console.log(JSON.stringify(dataset, null, 4));

            if(dataset.project.removed) {
                console.log("project is removed - no need to move");
                return next_dataset();
            }
            dataset.project = dataset.project._id; //unpopulate 

            //open destination first 
            //TODO if we open the source first, it somehow ends up truncating the first part of the file..... find out why!?
            config.storage_systems.wrangler.upload(dataset, (err, write, success)=>{
                if(err) throw err;

                //then open source
                config.storage_systems.jetstream.download(dataset, (err, read, filename)=>{
                    if(err) throw err;
                    if(~filename.indexOf(".tar.gz")) {
                        console.log(".tar.gz (old) dataset shouldbe un-zipped.. skipping");
                        return next_dataset();
                    }

                    //start transfer
                    console.log("piping");
                    read.pipe(write);
                    success.then(stat=>{
                        console.dir(stat);
                        //console.log("dataset size:"+dataset.size);
                        //console.log("stat.size:"+stat.size);
                        if(dataset.size != stat.size) throw new Error("dataset size not the same");
                        console.log("removing");
                        config.storage_systems.jetstream.remove(dataset, err=>{
                            if(err) throw err;

                            console.log("saving");
                            dataset.storage_config = undefined;
                            dataset.storage = "wrangler";
                            dataset.save(next_dataset);
                        });
                    }).catch(err=>{
                        throw err;
                    });
                });
            });
        }, cb);
    });
}


