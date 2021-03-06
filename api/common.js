
//TODO switch to axios!
const request = require('request');
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
const amqp = require("amqp"); //switch to amqplib?
const axios = require('axios');

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
    //let's allow access to public project from un-authenticated user so that they can browser public projects on brainlife
    //if(user === undefined) return cb(null, [], []);
    
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
            if(user && p.members.includes(user)) return true;
            if(user && p.admins.includes(user)) return true;
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
            if(!~canwrite_project_ids.indexOf(id)) err = "you("+user+") don't have write access to project:"+id;
        });
        cb(err);
    });
}

//copy exists in amaretti/ common.js
exports.escape_dot = function(obj) {
    if(typeof obj == "object") {
        for(let key in obj) {
            exports.escape_dot(obj[key]);
            if(key.includes(".")) {
                let newkey = key.replace(/\./g, '-');
                obj[newkey] = obj[key];
                delete obj[key];
            }
        }
    }
    return obj;
}

//TODO should inline this?
function register_dataset(task, output, product, cb) {
    db.Datasets.create({
        user_id: task.user_id,
        project: output.archive.project,
        desc: output.archive.desc,

        tags: product.tags,
        meta: product.meta,
        datatype: output.datatype,
        datatype_tags: product.datatype_tags,

        //status: "waiting",
        status_msg: "Waiting for the archiver ..",
        //product: escape_dot(product),

        prov: {
            //only store the most important things
            task: {
                _id: task._id,
                follow_task_id: task.follow_task_id, //for _dtv

                name: task.name,
                config: task.config,
                service: task.service,
                service_branch: task.service_branch,

                instance_id: task.instance_id,
                resource_id: task.resource_id,
                commit_id: task.commit_id,
                user_id: task.user_id,

                create_date: task.create_date,
                start_date: task.start_date,
                finish_date: task.finish_date,
            },
            output_id: output.id,
            subdir: output.subdir, //optional

            instance_id: task.instance_id, //deprecated use prov.task.instance_id
            task_id: task._id, //deprecated. use prov.task._id
        },
    }, (err, _dataset)=>{
        if(err) return cb(err);
        
        //store product in different table
        db.DatasetProducts.create({
            dataset_id: _dataset._id,
            product: exports.escape_dot(product),

            //I think we always query datasets first, then load product as necessary
            //if so, the I don't think we need to store service/branch - just look up from dataset?
            //service: task.service,
            //service_branch: task.service_branch,

        }, (err, _dataset_product)=>{
            if(!err) exports.publish("dataset.create."+task.user_id+"."+output.archive.project+"."+_dataset._id, _dataset);
            cb(err, _dataset);
        });
    });
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
            cb(task.status_msg);
        }
    });
}

//TODO - I should create more generic version of this
exports.issue_archiver_jwt = async function(user_id, cb) {

    //load user's gids so that we can add warehouse group id (authorized to access archive)
    //I need existing user's gids so that user can submit stating task on the instance that user should have access to
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

//register new dataset and submits brainlife/app-archive to archive data for it
exports.archive_task_outputs = async function(user_id, task, outputs, cb) {
    if(!Array.isArray(outputs)) {
        return cb("archive_task_outputs/outputs is not array "+JSON.stringify(outputs, null, 4));
    }

    let task_products = await rp.get({
        url: config.amaretti.api+"/task/product/", json: true,
        qs: {
            ids: [task._id],
        },
        headers: { authorization: "Bearer "+config.warehouse.jwt, },
    });
    let task_product;
    if(task_products.length == 1) {
        task_product = task_products[0].product;
    } else {
        //fallback on the old task.product - in case user is still running old jobs
        task_product = task.product;
    }
    let products = exports.split_product(task_product, outputs);

    //get all project ids set by user
    let project_ids = [];
    outputs.forEach(output=>{
        if(output.archive && !~project_ids.indexOf(output.archive.project)) project_ids.push(output.archive.project);
    });
    
    //handles multiple output datasets, but they should all belong to the same project.
    //if not, app-archive will fail..
    if(project_ids.length == 0) return cb(); //nothing to archive?
    if(project_ids.length > 1) return cb("archive_task_outputs can't handle request with mixed projects");
    let project = await db.Projects.findById(project_ids[0]);
    let storage = project.storage||config.archive.storage_default;
    let storage_config = project.storage_config||config.archive.storage_config;

    //check project access
    exports.validate_projects(user_id, project_ids, err=>{
        if(err) return cb(err);
        let datasets = []; 
        let dataset_configs = []; 
        let subdirs;
        let noSubdirs = false;
        async.eachSeries(outputs, (output, next_output)=>{

            //only archive output that has archive requested
            if(!output.archive) return next_output();

            register_dataset(task, output, products[output.id], async (err, dataset)=>{
                if(err) return next_output(err);
                if(!dataset) return next_output(); //couldn't register, or already registered
                let dir =  "../"+task._id;
                let dataset_config = {
                    project: output.archive.project,
                    dir,

                    //dataset,  //used for .brainlife.json
                    dataset_id: dataset._id,

                    //should be the same across all requested dataset (these are set by event_handler when app-achive finishes successfully)
                    storage,
                    storage_config,
                }
                if(output.subdir) {
                    //new subdir outputs
                    dataset_config.dir+="/"+output.subdir;
                    if(!subdirs) subdirs = [];
                    subdirs.push(output.subdir);
                } else {
                    //old method - need to lookup datatype first
                    let datatype = await db.Datatypes.findById(output.datatype);
                    dataset_config.files = datatype.files;
                    dataset_config.files_override = output.files;
                    noSubdirs = true; //old method requires the entire workdir to be synced.
                }
                dataset_configs.push(dataset_config);
                datasets.push(dataset);
                next_output();
            });
        }, async err=>{
            if(err) return cb(err);
            if(datasets.length == 0) return cb();
            try {
                //only archiver group user can run app-stage/arcvehi, 
                //so I need to add group access temporarily
                let user_jwt = await exports.issue_archiver_jwt(user_id);

                //submit app-archive!
                let remove_date = new Date();
                remove_date.setDate(remove_date.getDate()+1); //remove in 1 day
                if(noSubdirs) subdirs = undefined;
                console.log("submitting app-archive");
                let archive_task_res = await axios.post(config.amaretti.api+"/task", {
                    deps_config: [ {task: task._id, subdirs } ],
                    service: "brainlife/app-archive",
                    service_branch: "1.1",
                    instance_id: task.instance_id,
                    config: {
                        datasets: dataset_configs,
                    },
                    max_runtime: 1000*3600, //1 hour should be enough for most..
                    remove_date,

                    //for slate?
                    //preferred_resource_id: storage_config.resource_id,
                },{
                    headers: {
                        authorization: "Bearer "+user_jwt,
                    }
                });

                //note: archive_task_id is set by event_handler while setting other things like status, desc, status_msg, etc..
                logger.info("submitted archive_task:"+archive_task_res.data.task._id);
                cb(null, datasets, archive_task_res.data.task);
            } catch(err) {
                cb(err);
            }
        });
    });
}

//get new information from github and apply it to app document
exports.update_appinfo = function(app, cb) {
    let service_name = app.github;
    exports.load_github_detail(service_name, (err, repo, con_details)=>{
        if(err) return cb(err);
        app.desc = repo.description;
        app.tags = repo.topics;
        if(!app.stats) app.stats = {};
        app.stats.stars = repo.stargazers_count;
        app.markModified('stats');
        app.contributors = con_details.map(con=>{
            //see https://api.github.com/users/francopestilli for other fields
            return {name: con.name, email: con.email};
        });
        cb();
    });
}

exports.load_github_detail = function(service_name, cb) {
    if(!config.github) return cb("no github config");
    request("https://api.github.com/repos/"+service_name, { json: true, headers: {
        //needed to get topic (which is currently in preview mode..)
        //https://developer.github.com/v3/repos/#list-all-topics-for-a-repository
        'Authorization': 'token '+config.github.access_token,
        'User-Agent': 'brain-life/warehouse',
        'Accept': "application/vnd.github.mercy-preview+json", 
    }}, function(err, _res, git) {
        if(err) return cb(err);
        if(_res.statusCode != 200) {
            logger.error(_res.body);
            return cb("failed to query requested repo. code:"+_res.statusCode);
        }
        //logger.debug(_res.headers);

        logger.debug("loading contributors");
        request("https://api.github.com/repos/"+service_name+"/contributors", { json: true, headers: {
            'Authorization': 'token '+config.github.access_token,
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
                request(con.url, { json: true, headers: {
                    'Authorization': 'token '+config.github.access_token,
                    'User-Agent': 'brain-life/warehouse',
                } }, function(err, _res, detail) {
                    if(err) return next_con(err);
                    if(_res.statusCode != 200) {
                        logger.error(_res.body);
                        return next_con("failed to load user detail:"+_res.statusCode);
                    }
                    //logger.debug(_res.headers);
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

    //datacite requires at least 1 creator.. if we fail to find at least 1 admin contact, let's use franco's name
    if(creators.length == 0) {
        creators.push(`<creator><creatorName>Franco Pestilli</creatorName></creator>`);
    }

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
    axios.get(config.auth.api+"/profile/list", {
        params: {
            limit: 5000, //TODO -- really!?
        },
        headers: { authorization: "Bearer "+config.warehouse.jwt }, //config.auth.jwt is deprecated
    }).then(res=>{
        if(res.status != 200) logger.error("couldn't cache auth profiles. code:"+res.status);
        else {
            res.data.profiles.forEach(profile=>{
                cached_contacts[profile.sub] = profile;
            });
            console.log("cached profile len:", res.data.profiles.length);
            if(cb) cb();
        }
    }).catch(err=>{
        if(cb) cb(err);
        else console.error(err);
    });
}

exports.cache_contact();
setInterval(exports.cache_contact, 1000*60*30); //cache every 30 minutes

exports.deref_contact = function(id) {
    return cached_contacts[id];
}

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
let connect_amqp = new Promise((resolve, reject)=>{
    console.log("creating connection to amqp server");
    amqp_conn = amqp.createConnection(config.event.amqp, {reconnectBackoffTime: 1000*10});
    amqp_conn.once("ready", ()=>{
        resolve(amqp_conn);
    });
    amqp_conn.on("error", err=>{
        console.error(err);
        reject();
    });
});

let warehouse_ex;
exports.get_amqp_connection = function(cb) {
    connect_amqp.then(conn=>{
        conn.exchange("warehouse", {autoDelete: false, durable: true, type: 'topic', confirm: true}, ex=>{
            warehouse_ex = ex;
            cb(null, conn);
        })
    }).catch(cb);
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

exports.update_dataset_stats = async function(project_id, cb) {
    logger.debug("updating dataset stats project:%s", project_id);
    project_id = mongoose.Types.ObjectId(project_id);

    try {
        //create inventory stats
        let inventory = await db.Datasets.aggregate()
            .match({ removed: false, project: project_id, })
            .group({_id: {
                "subject": "$meta.subject", 
                "datatype": "$datatype", 
            }, count: {$sum: 1}, size: {$sum: "$size"} })
            .sort({"_id.subject":1});
        let subjects = new Set();
        let stats = {
            subject_count: 0,
            count: 0, 
            size: 0,
            datatypes_detail: [],
        }
        inventory.forEach(item=>{
            subjects.add(item._id.subject);
            
            //some project contains dataset without datatype??
            if(item._id.datatype) {
                let type = item._id.datatype;
                let datatype = stats.datatypes_detail.find(datatype=>datatype.type.toString() == type.toString());
                if(datatype) {
                    datatype.subject_count++;
                    datatype.count += item.count;
                    datatype.size += item.size;
                } else {
                    stats.datatypes_detail.push({ type, count: item.count, size: item.size, subject_count: 1 });
                }
            }

            //calculate total
            stats.count += item.count;
            stats.size += item.size;
        });
        stats.subject_count = subjects.size;
        exports.publish("project.update.warehouse."+project_id, {stats: {
            datasets: stats
        }})
        let doc = await db.Projects.findByIdAndUpdate(project_id, {$set: {"stats.datasets": stats}}, {new: true});

        if(cb) cb(null, doc);
    } catch(err) {
        if(cb) cb(err);
        else logger.error(err);
    }
}

//TODO - this function list *all* secondary archives. maybe I should filter out archives that didn't 
//get archived into data-object archive? I think the easier way to do this is to store secondary archive info 
//on each archived dataset. I can then just query all that and dump ot. 
exports.update_secondary_index = async function(project) {
    //console.log("updating secondary output index file for project", project._id);
    let participants = await db.Participants.findOne({project}).lean();
    
    //migrate
    if(participants && participants.rows) {
        console.log("renaming rows to subjects (rows are deprecated now)");
        participants.subjects = participants.rows;
        delete participants.rows;
    }

    //now load the index
    const _res = await axios.get(config.amaretti.api+'/task', {
        params: {
            //select: 'config.validator_task._id config.validator_task.follow_task_id instance_id',
            select: 'config instance_id',
            find: JSON.stringify({
                'finish_date': {$exists: true},
                'service': 'brainlife/app-archive-secondary',
                '_group_id': project.group_id,
            }),
            limit: 20000, //TODO.. how scalable is this!?
        },
        headers: { authorization: "Bearer "+config.warehouse.jwt },
    });

    let validator_ids = _res.data.tasks.map(task=>task.config.validator_task._id);
    let datatype_ids = [];
    _res.data.tasks.forEach(task=>{
        let id = task.config.validator_task.config._outputs[0].datatype;
        if(!datatype_ids.includes(id)) datatype_ids.push(id);
    });

    //lookup datatype names
    let datatypes = await db.Datatypes.find({_id: {$in: datatype_ids}}, {name:1,desc:1,files:1}).lean();
    let datatypes_obj = {};
    datatypes.forEach(rec=>{
        datatypes_obj[rec._id] = rec;
    });

    let sectasks = _res.data.tasks.map(task=>{
        let output = task.config.validator_task.config._outputs[0];
        return {
            //group_id: project.group_id,
            //instance_id: task.instance_id,
            //follow_task_id: task.config.validator_task.follow_task_id,
            //validator_task_id: task.config.validator_task._id,
            //output_id: output.id,
            //datatype_id: output.datatype,
            datatype: datatypes_obj[output.datatype],
            meta: output.meta,
            tags: output.tags,
            datatype_tags: output.datatype_tags,

            path: task.instance_id+"/"+task.config.validator_task.follow_task_id+"/"+output.id+"/secondary",
        }
    });

    //merge sectasks into participants.subjects
    let index = {
        //project,
        subjects: {},
    };
    if(participants) {
        index.columns = participants.columns;
        for(let subject in participants.subjects) {
            if(!index.subjects[subject]) index.subjects[subject] = {}
            index.subjects[subject].phenotype = participants.subjects[subject];
        }
    }
    sectasks.forEach(sectask=>{
        let subject = sectask.meta.subject;
        if(!index.subjects[subject]) index.subjects[subject] = {}
        if(!index.subjects[subject].items) index.subjects[subject].items = [];
        index.subjects[subject].items.push(sectask);
    });

    const path = config.groupanalysis.secondaryDir+"/"+project.group_id+"/index.json";
    console.log("storing index.json", path);
    fs.writeFileSync(path, JSON.stringify(index, null, 4));
}

exports.update_project_stats = async function(project, cb) {
    try {
        let counts = await rp.get({
            url: config.amaretti.api+"/instance/count", json: true,
            qs: {
                find: JSON.stringify({status: {$ne: "removed"}, group_id: project.group_id}),
            },
            headers: { authorization: "Bearer "+config.warehouse.jwt, },
        });
        let instance_counts = counts[0]; //there should be only 1

        let stats = await db.Rules.aggregate()
            .match({removed: false, project: project._id})
            .group({_id: { "active": "$active" }, count: {$sum: 1}});
        
        let rules = {
            active: 0,
            inactive: 0,
        }
        stats.forEach(rec=>{
            if(rec._id.active) rules.active = rec.count;
            else rules.inactive = rec.count;
        });

        //TODO query task/resource_service_count api
        let resource_usage = await rp.get({
            url: config.amaretti.api+"/task/resource_usage", json: true,
            qs: {
                find: JSON.stringify({/*status: {$ne: "finished"},*/ _group_id: project.group_id}),
            },
            headers: { authorization: "Bearer "+config.warehouse.jwt, },
        });

        //TODO resource_usage api returns group with no resource_id attached.. (bug?) let's filter them out for now
        resource_usage = resource_usage.filter(r=>r._id.resource_id !== undefined);

        //load resource details to be merged into the resource_usage info
        let resource_ids = resource_usage.map(raw=>raw._id.resource_id);
        let {resources} = await rp.get({
            url: config.amaretti.api+"/resource", json: true,
            qs: {
                find: JSON.stringify({_id: {$in: resource_ids}, user_id: null}),
            },
            headers: { authorization: "Bearer "+config.warehouse.jwt, },
        });
        let resource_stats = resource_usage.map(raw=>{
            let resource = resources.find(r=>r._id == raw._id.resource_id);
            return {
                service: raw._id.service,
                resource_id: raw._id.resource_id, 

                //resource detail for quick reference
                name: resource.name,
                desc: resource.config.desc,
                citation: resource.citation,

                count: raw.count,
                total_walltime: raw.total_walltime,
            }
        });

        let publications = await db.Publications.countDocuments({project});
        let newproject = await db.Projects.findOneAndUpdate({_id: project._id}, {$set: {
            "stats.rules": rules, 
            "stats.resources": resource_stats, 
            "stats.publications": publications,
            "stats.instances": instance_counts,
        }}, {new: true});

        //logger.debug("all done for updating project stats");
        if(cb) cb(null, newproject);

    } catch (err) {
        if(cb) cb(err);
        else logger.error(err);
    }
}

exports.update_rule_stats = function(rule_id, cb) {
    axios.get(config.amaretti.api+"/task", {
        params: {
            find: JSON.stringify({'config._rule.id': rule_id, status: {$ne: "removed"}}),
            select: 'status', 
            limit: 3000,
        },
        headers: { authorization: "Bearer "+config.warehouse.jwt, },
    }).then(res=>{
        let tasks = res.data.tasks;
        if(!tasks) return cb(body);
        let stats = {}
        tasks.forEach(task=>{
            if(stats[task.status] === undefined) stats[task.status] = 0;
            stats[task.status]+=1;
        });
        db.Rules.findOneAndUpdate({_id: rule_id}, {$set: {"stats.tasks": stats}}, {new: true}, (err, rule)=>{
            if(cb) cb(err, rule);
            let sub = "warehouse";
            exports.publish("rule.update."+sub+"."+rule.project+"."+rule._id, rule)
        });
    }).catch(cb);
}

exports.dataset_to_filename = function(dataset) {
    let path ="dt-"+dataset.datatype.name.replace(/\//g, '-');
    dataset.datatype_tags.forEach(tag=>{
        //null is getting injected into datatype_tags.. until I find where it's coming from, 
        //I need to patch this by ignoring this
        if(!tag) return; 
        path+=".tag-"+tag.replace(/\./g, '-'); //'.' is used as delimiter
    });
    if(dataset.meta.run) path += ".run-"+dataset.meta.run;
    path+= ".id-"+dataset._id;
    return path;
}

exports.publish = (key, message, cb)=>{
    if(!message) message = {};
    message.timestamp = (new Date().getTime())/1000; //it's crazy that amqp doesn't set this?
    if(!warehouse_ex) { 
        console.error("warehouse_ex not connected yet.. can't publish");
    } else warehouse_ex.publish(key, message, {}, cb);
}

exports.isadmin = (user, rec)=>{
    if(user) {
        if(user.scopes.warehouse && ~user.scopes.warehouse.indexOf('admin')) return true;
        if(~rec.admins.indexOf(user.sub.toString())) return true;
    }
    return false;
}

exports.ismember = (user, rec)=>{
    if(user) {
        if(user.scopes.warehouse && ~user.scopes.warehouse.indexOf('admin')) return true;
        if(~rec.members.indexOf(user.sub.toString())) return true;
    }
    return false;
}

exports.users_general = async ()=>{
    console.log("loading users");
    let users = await rp.get({
        url: config.auth.api+"/profile/list", json: true,
        qs: {
            find: JSON.stringify({
                active: true,
                "profile.private.notification.newsletter_general": true,
            }),
            limit: 3000,
        },
        headers: { authorization: "Bearer "+config.warehouse.jwt },
    });
    return users.profiles;
}

exports.list_users = async ()=>{
    let year_ago = new Date();
    year_ago.setDate(year_ago.getDate() - 365);

    let week_ago = new Date();
    week_ago.setDate(year_ago.getDate() - 7);

    let users = await rp.get({
        url: config.auth.api+"/profile/list", json: true,
        qs: {
            find: JSON.stringify({
                active: true,
            }),
            limit: 3000,
        },
        headers: { authorization: "Bearer "+config.warehouse.jwt },
    });
    let lists = {
        active: [],
        inactive: [],
        recent: [],
    }
    users.profiles.forEach(user=>{
        if(!user) return;

        if(user.times && (
            new Date(user.times.github_login) > year_ago ||
            new Date(user.times.google_login) > year_ago ||
            new Date(user.times.local_login) > year_ago ||
            new Date(user.times.orcid_login) > year_ago)) {
            lists.active.push(user);
        } else {
            lists.inactive.push(user);
        }

        if(user.times && new Date(user.times.register) > week_ago) lists.recent.push(user);
    });
    return lists;
}

