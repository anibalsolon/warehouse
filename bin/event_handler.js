#!/usr/bin/env node

const amqp = require('amqp');
const winston = require('winston');
const mongoose = require('mongoose');
const async = require('async');
const request = require('request');
const redis = require('redis');

const config = require('../api/config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../api/models');
const common = require('../api/common');
const prov = require('../api/prov');

// TODO  Look for failed tasks and report to the user/dev?

logger.info("starting event handler");

setInterval(health_check, 1000*60*3); //It has to be long enough - when it needs to transfer data

db.init(err=>{
    logger.info("connected to mongo");
});

//init and start 
var acon = amqp.createConnection(config.event.amqp, {reconnectBackoffTime: 1000*10});
acon.on('error', logger.error);
acon.on('ready', ()=>{
    logger.info("connected to amqp");
    subscribe();
});

var rcon = redis.createClient(config.redis.port, config.redis.server);
rcon.on('error', logger.error);
rcon.on('ready', ()=>{
    logger.info("connected to redis");
});

function subscribe() {
    async.series([
        //ensure queues/binds and subscribe to instance events
        next=>{
            logger.debug("subscribing to instance event");
            acon.queue('warehouse.instance', {durable: true, autoDelete: false}, instance_q=>{
                logger.debug("binding wf.instance > warehouse.instance");
                instance_q.bind('wf.instance', '#');
                instance_q.subscribe({ack: true}, (instance, head, dinfo, ack)=>{
                    handle_instance(instance, err=>{
                        if(err) {
                            logger.error(err)
                            //continue .. TODO - maybe I should report the failed event to failed queue?
                        }
                        instance_q.shift();
                    });
                });
                next();
            });
        },
     
        //ensure queues/binds and subscribe to task events
        next=>{
            logger.debug("subscribing to task event");
            acon.queue('warehouse.task', {durable: true, autoDelete: false}, task_q=>{
                logger.debug("binding wf.task > warehouse.task");
                task_q.bind('wf.task', '#');
                task_q.subscribe({ack: true}, (task, head, dinfo, ack)=>{
                    handle_task(task, err=>{
                        if(err) {
                            logger.error(err)
                            //TODO - maybe I should report the failed event to failed queue?
                        }
                        task_q.shift();
                    });
                });
                next();
            });
        },
        
    ], err=>{
        if(err) throw err;
        logger.info("done subscribing");
    });
}

var _counts = {
    tasks: 0,
    instances: 0,
}

function health_check() {
    //logger.debug("health check");
    var report = {
        status: "ok",
        messages: [],
        date: new Date(),
        counts: _counts,
        //_health,
        maxage: 1000*60*6,  //should be double the check frequency to avoid going stale while development
    }

    if(_counts.tasks == 0) {
        report.status = "failed";
        report.messages.push("task event counts is low");
    }

    rcon.set("health.warehouse.event."+(process.env.NODE_APP_INSTANCE||'0'), JSON.stringify(report));

    //reset counter
    _counts.tasks = 0;
    _counts.instances = 0;
}

function handle_task(task, cb) {
    _counts.tasks++;

    prov.register_task(task, err=>{
        if(err) return logger.error(err);
    });

    if(task.status == "finished" && task.config && task.config._outputs) {
        logger.info("handling task", task._id, task.status, task.name);
        async.eachSeries(task.config._outputs, (output, next_output)=>{
            if(!output.archive) return next_output();
            archive_dataset(task, output, next_output);
        }, cb);
    } else {
        logger.debug("ignoring task", task._id, task.status, task.name);
        cb();
    }
}

function archive_dataset(task, output, cb) {
    logger.debug("archive request made", output);

    var dataset = null;
    var datatype = null;
	var auth = null;

    async.series([
        next=>{
            logger.debug("see if this dataset is already archived");
            db.Datasets.findOne({
                "prov.task_id": task._id,
                "prov.output_id": output.id,
                
                //ignore failed and removed ones
                //TODO - very strange query indeed.. but it should work
                $or: [
                    { removed: true, status: {$ne: "failed"} }, //if removed and not failed, user must have a good reason to remove it.. keep it (not reachive)
                    { removed: false }, //if not removed, then good!
                ]
                
            }).exec((err,_dataset)=>{
                if(err) return cb(err);
                if(_dataset) {
                    logger.info("already archived");
                    return cb();
                }
                logger.debug("not yet archived.. proceeding", task._id, output.id);
                next();
            });
        },

        next=>{
            logger.debug("registering dataset now");

            var tags = output.tags||[];
            if(task.product && task.product.tags) tags = task.product.tags; //product.tags takes precedence
            var datatype_tags = output.datatype_tags||[];
            if(task.product && task.product.datatype_tags) tags = task.product.datatype_tags; //product.datatype_tags takes precedence

            new db.Datasets({
                user_id: task.user_id,

                project: output.archive.project,
                datatype: output.datatype,
                datatype_tags,

                desc: output.archive.desc,
                tags,

                prov: {
                    instance_id: task.instance_id,
                    task_id: task._id,
                    app: task.config._app, //deprecated
                    //app_id: task.config._app, //deprecated
                    output_id: output.id,
                    subdir: output.subdir,
                },
                meta: output.meta||{},
            }).save((err, _dataset)=>{
                dataset = _dataset;
                next(err);
            });
        },

		next=>{
			logger.debug("issue jwt to download dataset");
			request.get({
				url: config.auth.api+"/jwt/"+task.user_id, json: true,
				headers: { authorization: "Bearer "+config.auth.jwt },
			}, (err, res, body)=>{
				if(err) return next(err);
				if(res.statusCode != 200) return cb("couldn't obtain user jwt code:"+res.statusCode);
				auth = "Bearer "+body.jwt;
				next();
			});
		},

		next=>{
            logger.debug("transfering data from task");
            common.archive_task(task, dataset, output.files, auth, next);
		},
    ], cb);
}

function handle_instance(instance, cb) {
    _counts.instances++;

    logger.debug("TODO",instance);
    cb();
}

