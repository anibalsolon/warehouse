const request = require('request'); //TODO - switch to rp
const rp = require('request-promise-native');
const winston = require('winston');
const tmp = require('tmp');
const mkdirp = require('mkdirp');
const path = require('path');
const child_process = require('child_process');
const fs = require('fs');
const async = require('async');
const redis = require('redis');
const xmlescape = require('xml-escape');
const amqp = require("amqp");

const config = require('./config');
const logger = winston.createLogger(config.logger.winston);
const db = require('./models');
const mongoose = require('mongoose');

//connect to redis - used to store various shared caches
//TODO - user needs to call redis.quit();
exports.redis = redis.createClient(config.redis.port, config.redis.server);
exports.redis.on('error', err=>{throw err});

//TODO - should be called something like "get_project_accessiblity"?
exports.getprojects = function(user, cb) {
    if(user === undefined) return cb(null, [], []);
    //string has sub() so I can't just do if(user.sub)
    if(typeof user == 'object') user = user.sub.toString();
    
    //everyone has read access to public project
    let project_query = {access: "public"};
    
    //logged in user may have acess to more projects
    project_query = {
        $or: [
            project_query,
            {"members": user},
            {"admins": user}, 
            {"guests": user},
        ],
    };
    db.Projects.find(project_query).select('_id admins members guests').lean().exec((err, projects)=>{
        if(err) return cb(err);
        //user can read from all matching projects
        let canread_ids = projects.map(p=>p._id);

        //user has write access if they are listed in members/admins
        let canwrite_projects = projects.filter(p=>{
            if(p.members.includes(user)) return true;
            if(p.admins.includes(user)) return true;
            return false;
        });
        let canwrite_ids = canwrite_projects.map(p=>p._id);
        cb(null, canread_ids, canwrite_ids);
    });
}

//check if user has access to all projects in (write access) projects_id
exports.validate_projects = function(user, project_ids, cb) {
    if(!project_ids) return cb(); //no project, no checking necessary
    exports.getprojects(user, (err, canread_project_ids, canwrite_project_ids)=>{
        if(err) return cb(err);

        //need to convert all ids to string..
        canwrite_project_ids = canwrite_project_ids.map(id=>id.toString());

        //iterate each ids to see if user has access
        var err = null;
        project_ids.forEach(id=>{
            if(!~canwrite_project_ids.indexOf(id)) err = "you don't have write access to project:"+id;
        });
        cb(err);
    });
}

//TODO should inline this?
function register_dataset(task, output, product, cb) {
    new db.Datasets({
        user_id: task.user_id,
        project: output.archive.project,
        desc: output.archive.desc,

        tags: product.tags,
        meta: product.meta,
        datatype: output.datatype,
        datatype_tags: product.datatype_tags,

        //status: "waiting",
        status_msg: "Waiting for the archiver ..",
        product,
        
        prov: {
            task, 
            output_id: output.id, 
            subdir: output.subdir, //optional

            instance_id: task.instance_id, //deprecated use prov.task.instance_id
            task_id: task._id, //deprecated. use prov.task._id
        },
    }).save(cb); 
}

//wait for a task to terminate .. finish/fail/stopped/removed
exports.wait_task = function(req, task_id, cb) {
    logger.info("waiting for task to finish id:"+task_id);
    request.get({
        url: config.amaretti.api+"/task/"+task_id,
        json: true,
        headers: {
            authorization: req.headers.authorization,
        }
    }, (err, _res, task)=>{
        if(err) return cb(err);
        switch(task.status) {
        case "finished":
            cb();
            break;
        case "requested":
        case "running":
        case "running_sync":
            setTimeout(()=>{
                exports.wait_task(req, task_id, cb);
            }, 2000);
            break;
        default:
            logger.debug("wait_task detected failed task")
            //console.dir(JSON.stringify(task, null, 4));
            //consider all else as failed
            cb(task.status_msg);
        }
    });
}

exports.issue_archiver_jwt = async function(user_id, cb) {
    //load user's gids so that we can add warehouse group id (authorized to access archive)
    let gids = await rp.get({
        url: config.auth.api+"/user/groups/"+user_id,
        json: true,
        headers: {
            authorization: "Bearer "+config.warehouse.jwt,
        }
    });
    
    ///add warehouse group that allows user to submit
    gids = gids.concat(config.archive.gid);  

    //issue user token with added gids priviledge
    let {jwt: user_jwt} = await rp.get({
        url: config.auth.api+"/jwt/"+user_id,
        json: true,
        qs: {
            claim: JSON.stringify({gids}),
        },
        headers: {
            authorization: "Bearer "+config.warehouse.jwt,
        }
    });

    return user_jwt;
}

//submits brainlife/app-archive
exports.archive_task_outputs = function(task, outputs, cb) {
    if(!Array.isArray(outputs)) {
        return cb("archive_task_outputs/outputs is not array "+JSON.stringify(outputs, null, 4));
    }
    let products = exports.split_product(task.product||{}, outputs);

    //get all project ids set by user
    let project_ids = [];
    outputs.forEach(output=>{
        if(output.archive) project_ids.push(output.archive.project);
    });

    //check project access
    exports.validate_projects(task.user_id, project_ids, err=>{
        if(err) return cb(err);
        
        //register datasets
        let datasets = []; 
        async.eachSeries(outputs, (output, next_output)=>{
            if(!output.archive) return next_output();
            register_dataset(task, output, products[output.id], (err, dataset)=>{
                if(err || !dataset) return next_output(); //couldn't register, or already registered
                let dir =  "../"+task._id;
                //dataset.prov.task = dataset.prov.task._id; //unpopulate prov as it will be somewhat redundant (cli/bl-dataset-upload wants this)
                let dataset_config = {
                    project: output.archive.project,
                    dir,
                    dataset, //need to pass the dataet for .brainlife.io

                    storage: config.archive.storage_default,
                    
                    //TODO - should let config/index.js generate this?
                    //storage_config: { path: dataset.project+"/"+dataset._id+".tar" },
                }
                if(output.subdir) {
                    //new subdir outputs
                    dataset_config.dir+="/"+output.subdir,
                    datasets.push(dataset_config);
                    next_output();
                } else {
                    //old method - need to lookup datatype first
                    db.Datatypes.findById(output.datatype, (err, datatype)=>{
                        if(err) return next_output(err);
                        dataset_config.files = datatype.files;
                        dataset_config.files_override = output.files;
                        datasets.push(dataset_config);
                        next_output();
                    });
                }
            });
        }, async err=>{
            if(err) return cb(err);
            if(datasets.length == 0) return cb();
            try {
                let user_jwt = await exports.issue_archiver_jwt(task.user_id);

                //submit app-archive!
                let remove_date = new Date();
                remove_date.setDate(remove_date.getDate()+7); //remove in 7 days(?)
                let archive_task = await rp.post({
                    url: config.amaretti.api+"/task",
                    json: true,
                    body: {
                        deps : [ task._id ],
                        //name : "archiving",
                        //desc : "archiving",
                        service : "brainlife/app-archive",
                        instance_id : task.instance_id,
                        config: {
                            datasets,
                        },
                        max_runtime: 1000*3600, //1 hour should be enough for most..
                        remove_date,
                    },
                    headers: {
                        authorization: "Bearer "+user_jwt,
                    }
                });
                logger.info("submitted archive_task:"+archive_task.task._id);
                cb(null, archive_task.task);
            } catch(err) {
                cb(err);
            }
        });
    });
}

exports.pull_appinfo = function(service_name, cb) {
    let app = {};
    exports.load_github_detail(service_name, (err, repo, con_details)=>{
        if(err) return cb(err);
        app.desc = repo.description;
        app.tags = repo.topics;
        if(!app.stats) app.stats = {};
        app.stats.stars = repo.stargazers_count;
        app.contributors = con_details.map(con=>{
            //see https://api.github.com/users/francopestilli for other fields
            return {name: con.name, email: con.email};
        });
        //console.dir(app.contributors.toObject());
        cb(null, app);
    });

}

exports.load_github_detail = function(service_name, cb) {
    if(!config.github) return cb("no github config");

    let auth = "?client_id="+config.github.client_id + "&client_secret="+config.github.client_secret;

    //first load main repo info
    logger.debug("loading repo detail");
    logger.debug("https://api.github.com/repos/"+service_name+auth);
    request("https://api.github.com/repos/"+service_name+auth, { json: true, headers: {
        'User-Agent': 'brain-life/warehouse',
        //needed to get topic (which is currently in preview mode..)
        //https://developer.github.com/v3/repos/#list-all-topics-for-a-repository
        'Accept': "application/vnd.github.mercy-preview+json", 
    }}, function(err, _res, git) {
        if(err) return cb(err);
        if(_res.statusCode != 200) {
            logger.error(_res.body);
            return cb("failed to query requested repo. code:"+_res.statusCode);
        }
        logger.debug(_res.headers);

        logger.debug("loading contributors");
        request("https://api.github.com/repos/"+service_name+"/contributors"+auth, { json: true, headers: {
            'User-Agent': 'brain-life/warehouse',
        }}, function(err, _res, cons) {
            if(err) return cb(err);
            if(_res.statusCode != 200) {
                logger.error(_res.body);
                return cb("failed to query requested repo. code:"+_res.statusCode);
            }

            logger.debug("loading contributor details")
            let con_details = [];
            async.eachSeries(cons, (con, next_con)=>{
                request(con.url+auth, { json: true, headers: {'User-Agent': 'brain-life/warehouse'} }, function(err, _res, detail) {
                    if(err) return next_con(err);
                    if(_res.statusCode != 200) {
                        logger.error(_res.body);
                        return next_con("failed to load user detail:"+_res.statusCode);
                    }
                    logger.debug(_res.headers);
                    con_details.push(detail);
                    next_con();
                });
            }, err=>{
                cb(null, git, con_details);
            });
        });
    });
}
exports.compose_app_datacite_metadata = function(app) {
    //publication year
    let year = app.create_date.getFullYear();
    let publication_year = "<publicationYear>"+year+"</publicationYear>";

    let creators = [];
    app.admins.forEach(sub=>{
        let contact = cached_contacts[sub];
        if(!contact) {
            logger.debug("missing contact", sub);
            return;
        }
        //TODO - add <nameIdentifier nameIdentifierScheme="ORCID">12312312131</nameIdentifier>
        creators.push(`<creator><creatorName>${xmlescape(contact.fullname)}</creatorName></creator>`);
    });

    let contributors = [];
    if(app.contributors) app.contributors.forEach(contact=>{
        //contributorType can be ..
        //Value \'Contributor\' is not facet-valid with respect to enumeration \'[ContactPerson, DataCollector, DataCurator, DataManager, Distributor, Editor, HostingInstitution, Other, Producer, ProjectLeader, ProjectManager, ProjectMember, RegistrationAgency, RegistrationAuthority, RelatedPerson, ResearchGroup, RightsHolder, Researcher, Sponsor, Supervisor, WorkPackageLeader]\'. It must be a value from the enumeration.'
        contributors.push(`<contributor contributorType="Other"><contributorName>${xmlescape(contact.name)}</contributorName></contributor>`);
    });

    let subjects = []; //aka "keyword"
    app.tags.forEach(tag=>{
        subjects.push(`<subject>${xmlescape(tag)}</subject>`);
    });

    let metadata = `<?xml version="1.0" encoding="UTF-8"?>
    <resource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://datacite.org/schema/kernel-4" xsi:schemaLocation="http://datacite.org/schema/kernel-4 http://schema.datacite.org/meta/kernel-4/metadata.xsd">
      <identifier identifierType="DOI">${app.doi}</identifier>
      <creators>
        ${creators.join('\n')}
      </creators>
      <contributors>
        ${contributors.join('\n')}
      </contributors>
      <subjects>
        ${subjects.join('\n')}
      </subjects>
      <titles>
        <title>${xmlescape(app.name)}</title>
      </titles>
      <publisher>brainlife.io</publisher>
      ${publication_year}
      <resourceType resourceTypeGeneral="Software">XML</resourceType>
      <descriptions>
          <description descriptionType="Other">${xmlescape(app.desc_override||app.desc)}</description>
      </descriptions>
    </resource>`;
    //logger.debug(metadata);
    return metadata;
}

//https://schema.datacite.org/meta/kernel-4.1/doc/DataCite-MetadataKernel_v4.1.pdf
exports.compose_pub_datacite_metadata = function(pub) {

    //publication year
    let year = pub.create_date.getFullYear();
    let publication_year = "<publicationYear>"+year+"</publicationYear>";

    //in case author is empty.. let's use submitter as author..
    //TODO - we need to make author required field
    if(pub.authors.length == 0) pub.authors.push(pub.user_id);

    let creators = [];
    pub.authors.forEach(sub=>{
        let contact = cached_contacts[sub];
        if(!contact) {
            logger.debug("missing contact", sub);
            return;
        }
        //TODO - add <nameIdentifier nameIdentifierScheme="ORCID">12312312131</nameIdentifier>
        creators.push(`<creator><creatorName>${xmlescape(contact.fullname)}</creatorName></creator>`);
    });

    let contributors = [];
    pub.contributors.forEach(sub=>{
        let contact = cached_contacts[sub];
        if(!contact) {
            logger.debug("missing contact", sub);
            return;
        }
        //TODO - add <nameIdentifier nameIdentifierScheme="ORCID">12312312131</nameIdentifier>
        
        //contributorType can be ..
        //Value \'Contributor\' is not facet-valid with respect to enumeration \'[ContactPerson, DataCollector, DataCurator, DataManager, Distributor, Editor, HostingInstitution, Other, Producer, ProjectLeader, ProjectManager, ProjectMember, RegistrationAgency, RegistrationAuthority, RelatedPerson, ResearchGroup, RightsHolder, Researcher, Sponsor, Supervisor, WorkPackageLeader]\'. It must be a value from the enumeration.'
        contributors.push(`<contributor contributorType="Other"><contributorName>${xmlescape(contact.fullname)}</contributorName></contributor>`);
        
    });

    let subjects = []; //aka "keyword"
    pub.tags.forEach(tag=>{
        subjects.push(`<subject>${xmlescape(tag)}</subject>`);
    });

    let metadata = `<?xml version="1.0" encoding="UTF-8"?>
    <resource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://datacite.org/schema/kernel-4" xsi:schemaLocation="http://datacite.org/schema/kernel-4 http://schema.datacite.org/meta/kernel-4/metadata.xsd">
      <identifier identifierType="DOI">${pub.doi}</identifier>
      <creators>
        ${creators.join('\n')}
      </creators>
      <contributors>
        ${contributors.join('\n')}
      </contributors>
      <subjects>
        ${subjects.join('\n')}
      </subjects>
      <titles>
        <title>${xmlescape(pub.name)}</title>
      </titles>
      <publisher>brainlife.io</publisher>
      ${publication_year}
      <resourceType resourceTypeGeneral="Software">XML</resourceType>
      <descriptions>
          <description descriptionType="Other">${xmlescape(pub.desc)}</description>
      </descriptions>
    </resource>`;
    return metadata;
}

exports.get_next_app_doi = function(cb) {
    db.Apps.countDocuments({doi: {$exists: true}}).exec((err, count)=>{
        if(err) return cb(err);
        cb(null, config.datacite.prefix+"app."+count);
    });
}

//https://support.datacite.org/v1.1/docs/mds-2
//create new doi and register metadata (still needs to set url once it's minted)
exports.doi_post_metadata = function(metadata, cb) {
    //register!
    //logger.debug("registering doi metadata");
    request.post({
        url: config.datacite.api+"/metadata",
        auth: {
            user: config.datacite.username,
            pass: config.datacite.password,
        },
        headers: { 'content-type': 'application/xml' },
        body: metadata,
    }, (err, res, body)=>{
        if(err) return cb(err); 
        logger.debug('metadata registration:', res.statusCode, body);
        if(res.statusCode == 201) return cb(); //good!

        //consider all else failed!
        logger.error("failed to post metadata to datacite");
        logger.error(config.datacite.api+"/metadata");
        logger.error("user %s", config.datacite.username);
        return cb(body);
    });
}

//datacite api doc >  https://mds.test.datacite.org/static/apidoc
//set / update the url associated with doi
exports.doi_put_url = function(doi, url, cb) {
    console.log("registering doi url", url);
    request.put({
        url: config.datacite.api+"/doi/"+doi,
        auth: {
            user: config.datacite.username,
            pass: config.datacite.password,
        },
        headers: { 'content-type': 'text/plain' },
        body: "doi="+doi+"\nurl="+url,
    }, (err, res, body)=>{
        if(err) return cb(err); 
        logger.debug('url registration:', res.statusCode, body);
        if(res.statusCode != 201) return cb(body);
        cb(null);
    });
}

//TODO - update cache from amqp events
let cached_contacts = {};
exports.cache_contact = function(cb) {
    request({
        url: config.auth.api+"/profile", json: true,
        qs: {
            limit: 5000, //TODO -- really!?
        },
        headers: { authorization: "Bearer "+config.warehouse.jwt }, //config.auth.jwt is deprecated
    }, (err, res, body)=>{
        if(err) return logger.error(err);
        if(res.statusCode != 200) logger.error("couldn't cache auth profiles. code:"+res.statusCode);
        else {
            body.profiles.forEach(profile=>{
                cached_contacts[profile.id.toString()] = profile;
            });
            if(cb) cb();
        }
    });
}

exports.cache_contact();
setInterval(exports.cache_contact, 1000*60*30); //cache every 30 minutes

exports.deref_contact = function(id) {
    return cached_contacts[id];
}

/* bad pattern..
exports.populate_github_fields = function(repo, app, cb) {
    exports.load_github_detail(repo, (err, repo, con_details)=>{
        if(err) return cb(err);
        app.desc = repo.description;
        app.tags = repo.topics;
        if(!app.stats) app.stats = {};
        app.stats.stars = repo.stargazers_count;
        app.contributors = con_details.map(con=>{
            //see https://api.github.com/users/francopestilli for other fields
            return {name: con.name, email: con.email};
        });
        console.dir(app.contributors.toObject());
        cb();
    });
}
*/

//for split_product
Array.prototype.unique = function() {
    var a = this.concat();
    for(var i=0; i<a.length; ++i) {
        for(var j=i+1; j<a.length; ++j) {
            if(a[i] === a[j])
                a.splice(j--, 1);
        }
    }
    return a;
};

//split the task product into separate dataset products. flatten structure so that we merge *global* (applies to all dataset) product.json info
//to output for each datasets - for convenience and for backward compatibility
exports.split_product = function(task_product, outputs) {
    //create global product (everything except output.id keys)
    let global_product = Object.assign({}, task_product); //copy
    if(!Array.isArray(outputs)) {
        logger.error("broken outputs info");
        return {};
    }
    outputs.forEach(output=>{
        delete global_product[output.id]; //remove dataset specific output
    });

    function merge(dest, src) {
        for(let key in src) {
            if(!dest[key]) dest[key] = src[key];
            else {
                if(Array.isArray(src[key])) {
                    dest[key] = dest[key].concat(src[key]).unique(); //merge array
                } else if(typeof src[key] == 'object') {
                    Object.assign(dest[key], src[key]);
                } else {
                    //must be primitive
                    dest[key] = src[key];
                }
            }
        }
    }

    //put everything together - output specific data takes precedence over global
    let products = {};
    outputs.forEach(output=>{
        //pull things from config output
        products[output.id] = {
            tags: output.tags||[],
            datatype_tags: output.datatype_tags||[],
            meta: output.meta||{},
        };
        merge(products[output.id], global_product);
        if(task_product) merge(products[output.id], task_product[output.id])
    });

    return products;
}

//TODO - this has to match up between amaretti/bin/metrics and warehouse/api/controller querying for graphite daa
exports.sensu_name = function(name) {
    name = name.toLowerCase();
    name = name.replace(/[_.@$#\/]/g, "-");
    name = name.replace(/[ ()]/g, "");
    return name;
}

let amqp_conn;
exports.get_amqp_connection = function(cb) {
    if(amqp_conn) return cb(null, amqp_conn); //already connected
    amqp_conn = amqp.createConnection(config.event.amqp, {reconnectBackoffTime: 1000*10});
    amqp_conn.once("ready", ()=>{
        cb(null, amqp_conn);
    });
    amqp_conn.on("error", err=>{
        logger.error(err);
    });
}

exports.disconnect_amqp = function(cb) {
    if(amqp_conn) {
        logger.debug("disconnecting from amqp");
        amqp_conn.setImplOptions({reconnect: false}); //https://github.com/postwait/node-amqp/issues/462
        amqp_conn.disconnect();
    }
}

//connect to the amqp exchange and wait for a event to occur
exports.wait_for_event = function(exchange, key, cb) {
    exports.get_amqp_connection((err, conn)=>{
        if(err) {
            logger.error("failed to obtain amqp connection");
            return cb(err);
        }
        logger.info("amqp connection ready.. creating exchanges");
        conn.queue('', q=>{
            q.bind(exchange, key, ()=>{
                q.subscribe((message, header, deliveryInfo, messageObject)=>{
                    q.destroy();
                    cb(null, message);
                });
            });
        });
    });
}

exports.update_dataset_stats = function(project_id, cb) {
    logger.debug("updating dataset stats project:%s", project_id);
    project_id = mongoose.Types.ObjectId(project_id);

    db.Datasets.aggregate()
    .match({ removed: false, project: project_id, })
    .group({_id: {
        "subject": "$meta.subject", 
        "datatype": "$datatype", 
    }, count: {$sum: 1}, size: {$sum: "$size"} })
    .sort({"_id.subject":1})
    .exec((err, inventory)=>{
        if(err) return next(err);
        //console.dir(JSON.stringify(inventory, null, 4))
        let subjects = new Set();
        let datatypes = new Set();
        let stats = {
            subject_count: 0,
            count: 0, 
            size: 0,
        }
        inventory.forEach(item=>{
            subjects.add(item._id.subject);
            //some project contains dataset without datatype??
            if(item._id.datatype) datatypes.add(item._id.datatype.toString());
            stats.count += item.count;
            stats.size += item.size;
        });
        stats.subject_count = subjects.size;
        stats.datatypes = [...datatypes];
        db.Projects.findByIdAndUpdate(project_id, {$set: {"stats.datasets": stats}}, {new: true}, (err, doc)=>{
            if(cb) cb(err, doc);
        });
    });
}

exports.update_project_stats = function(group_id, cb) {
    logger.debug("getting instance status counts from amretti for group_id:%s", group_id);
    request.get({
        url: config.amaretti.api+"/instance/count", json: true,
        headers: { authorization: "Bearer "+config.warehouse.jwt },  //config.auth.jwt is deprecated
        qs: {
            find: JSON.stringify({status: {$ne: "removed"}, group_id}),
        }
    }, (err, res, counts)=>{
        if(res.statusCode != 200) return next(counts);
        stats = {};
        counts.forEach(count=>{
            switch(count._id) {
            case "requested": 
            case "finished": 
            case "running": 
            case "stopped": 
            case "failed": 
                stats[count._id] = count.count;
                break;
            default:
                //stats.instances["others"] += count.count;
            }
        });
        //console.dir(stats);
        db.Projects.findOneAndUpdate({group_id}, {$set: {"stats.instances": stats}}, {new: true}, (err, project)=>{
            if(err) return cb(err);

            logger.debug("updating rule stats for project_id:%s", project._id.toString());
            db.Rules.aggregate()
            //.match({removed: false, project: project_id})
            .match({removed: false, project})
            .group({_id: { "active": "$active" }, count: {$sum: 1}})
            .exec((err, ret)=>{
                let rules = {
                    active: 0,
                    inactive: 0,
                }
                ret.forEach(rec=>{
                    if(rec._id.active) rules.active = rec.count;
                    else rules.inactive = rec.count;
                });
                db.Projects.findOneAndUpdate({group_id}, {$set: {"stats.rules": rules}}, {new: true}, (err, project)=>{
                    if(cb) cb(err, project);
                });
            });
        });
    });
}

exports.update_rule_stats = function(rule_id, cb) {
    logger.debug("update_rule_stats:%s", rule_id);
    logger.debug(JSON.stringify({'config._rule.id': rule_id}, null, 4));
    request.get({
        url: config.amaretti.api+"/task", json: true,
        qs: {
            find: JSON.stringify({'config._rule.id': rule_id, status: {$ne: "removed"}}),
            select: 'status', 
            limit: 3000,
        },
        headers: { authorization: "Bearer "+config.warehouse.jwt, },
    }, (err, _res, body)=>{
        if(err) return cb(err);
        /*
8|warehous | { tasks: 
8|warehous |    [ { _id: '5c899b8c98cf8829f8df1c90', status: 'stop_requested' } ],
8|warehous |   count: 1 }
        */
        let stats = {}
        body.tasks.forEach(task=>{
            if(stats[task.status] === undefined) stats[task.status] = 0;
            stats[task.status]+=1;
        });
        db.Rules.findOneAndUpdate({_id: rule_id}, {$set: {"stats.tasks": stats}}, {new: true}, (err, rule)=>{
            if(cb) cb(err, project);
        });
    });
}


