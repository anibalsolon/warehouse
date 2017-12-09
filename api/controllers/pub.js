'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('express-jwt');
const winston = require('winston');
const async = require('async');

const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../models');
const common = require('../common');
const mongoose = require('mongoose');

/**
 * @apiGroup Publications
 * @api {get} /pub              Query registered publications
 *
 * @apiParam {Object} [find]    Optional Mongo find query - defaults to {}
 * @apiParam {Object} [sort]    Optional Mongo sort object - defaults to {}
 * @apiParam {String} [select]  Fields to load - multiple fields can be entered with %20 as delimiter
 * @apiParam {String} [populate] Relational fields to populate
 * @apiParam {Number} [limit]   Optional Maximum number of records to return - defaults to 0(no limit)
 * @apiParam {Boolean} [deref_contacts]  
 *                              Authors/ contributors are populated with (auth profile)
 * @apiParam {Number} [skip]    Optional Record offset for pagination
 *
 * @apiSuccess {Object}         List of publications (maybe limited / skipped) and total count. 
 */
router.get('/', (req, res, next)=>{
    let find = {};
	let skip = req.query.skip || 0;
	let limit = req.query.limit || 100;
    if(req.query.find) find = JSON.parse(req.query.find);
    db.Publications.find(find)
    .populate(req.query.populate || '') //all by default
    .select(req.query.select)
    .limit(+limit)
    .skip(+skip)
    .sort(req.query.sort || '_id')
    .lean()
    .exec((err, pubs)=>{
        if(err) return next(err);
        db.Datatypes.count(find).exec((err, count)=>{
            if(err) return next(err);

            //dereference user ID to name/email
            if(req.query.deref_contacts) pubs.forEach(pub=>{
                pub.authors = pub.authors.map(common.deref_contact);
                pub.contributors = pub.contributors.map(common.deref_contact);
            });
            res.json({pubs, count});
        });
    });
});

/**
 * @apiGroup Publications
 * @api {get} /pub/datasets-inventory/:pubid
 *                              Get counts of unique subject/datatype/datatype_tags. You can then use /pub/datasets/:pubid to get the actual list of datasets for each subject / datatypes / etc..
 *
 * @apiSuccess {Object}         Object containing counts
 * 
 */
//similar code in dataset.js
router.get('/datasets-inventory/:pubid', (req, res, next)=>{
    db.Datasets.aggregate()
    .match({ publications: mongoose.Types.ObjectId(req.params.pubid) })
    .group({_id: {"subject": "$meta.subject", "datatype": "$datatype", "datatype_tags": "$datatype_tags"}, 
        count: {$sum: 1}, size: {$sum: "$size"} })
    .sort({"_id.subject":1})
    .exec((err, stats)=>{
        if(err) return next(err);
        res.json(stats);
    });
});

/**
 * @apiGroup Publications
 * @api {get} /pub/apps/:pubid
 *                              Enumerate applications used to generate datasets
 *
 * @apiSuccess {Object[]}       Application objects
 * 
 */
router.get('/apps/:pubid', (req, res, next)=>{
    db.Datasets.find({
        publications: mongoose.Types.ObjectId(req.params.pubid) 
    })
    .distinct("prov.app")
    .exec((err, app_ids)=>{
        if(err) return next(err);
        db.Apps.find({
            _id: {$in: app_ids},
            projects: [], //only show *public* apps
        })
        .populate(req.query.populate || '')
        .exec((err, apps)=>{
            if(err) return next(err);
            res.json(apps);
        });
    });
});

/**
 * @apiGroup Publications
 * @api {get} /pub/datasets/:pubid  
 *                              Query published datasets
 *
 * @apiParam {Object} [find]    Optional Mongo find query - defaults to {}
 * @apiParam {Object} [sort]    Optional Mongo sort object - defaults to {}
 * @apiParam {String} [select]  Fields to load - multiple fields can be entered with %20 as delimiter
 * @apiParam {String} [populate] Relational fields to populate
 * @apiParam {Number} [limit]   Optional Maximum number of records to return - defaults to 0(no limit)
 * @apiParam {Number} [skip]    Optional Record offset for pagination
 *
 * @apiSuccess {Object}         List of dataasets (maybe limited / skipped) and total count
 */
router.get('/datasets/:pubid', (req, res, next)=>{
    let find = {};
	let skip = req.query.skip || 0;
	let limit = req.query.limit || 100;
    if(req.query.find) find = JSON.parse(req.query.find);
    let query = {$and: [ find, {publications: req.params.pubid}]};
    db.Datasets.find(query)
    .populate(req.query.populate || '') //all by default
    .select(req.query.select)
    .limit(+limit)
    .skip(+skip)
    .sort(req.query.sort || '_id')
    .lean()
    .exec((err, datasets)=>{
        if(err) return next(err);
        db.Datasets.count(query).exec((err, count)=>{
            if(err) return next(err);
            res.json({datasets, count});
        });
    });
});

//check if user can publish this project
function can_publish(req, project_id, cb) {
    if(typeof project_id === 'string') project_id = mongoose.Types.ObjectId(project_id);
    
    //check user has access to the project
    common.getprojects(req.user, function(err, canread_project_ids, canwrite_project_ids) {
        if(err) return cb(err);
        let found = canwrite_project_ids.find(id=>id.equals(project_id));
        cb(null, found);
    });
}

/**
 * @apiGroup Publications
 * @api {post} /pub                     Register new publication
 * @apiDescription                      Create new publication record. You have to register datasets via another API
 *
 * @apiParam {String} project           Project ID associated with this publication
 * @apiParam {String} license           License used for this publication
 * @apiParam {Object[]} fundings        Array of {funder, id}
 *
 * @apiParam {String[]} authors         List of author IDs.
 * @apiParam {String[]} contributors    List of contributor IDs.
 *
 * @apiParam {String} name              Publication title 
 * @apiParam {String} desc              Publication desc (short summary)
 * @apiParam {String} readme            Publication detail (paper abstract)
 * @apiParam {String[]} tags            Publication tags
 *
 * @apiParam {Boolean} removed          If this is a removed publication
 *
 * @apiHeader {String} authorization 
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}                 Publication record created
 *                              
 */
router.post('/', jwt({secret: config.express.pubkey}), (req, res, cb)=>{
    if(!req.body.project) return cb("project id not set");
    if(!req.body.license) return cb("license not set");
    if(!req.body.name) return cb("name not set");
    //TODO validate input?

    can_publish(req, req.body.project, (err, can)=>{
        if(err) return next(err);
        if(!can) return res.status(401).end("you can't publish this project");
        new db.Publications({
            user_id: req.user.sub, //user who submitted it

            project: req.body.project,
            name: req.body.name,
            desc: req.body.desc,
            readme: req.body.readme,
            tags: req.body.tags||[],

            license: req.body.license,
            fundings: req.body.fundings,

            authors: req.body.authors,
            contributors: req.body.contributors,

            removed: req.body.removed,
        }).save((err, _pub)=>{
            if(err) return next(err);
            res.json(_pub); 
        });
 
    });
});

/**
 * @apiGroup Publications
 * @api {put} /pub/:pubid          Update Publication
 *                              
 * @apiDescription              Update Publication
 *
 * @apiParam {String} license           License used for this publication
 * @apiParam {Object[]} fundings        Array of {funder, id}
 *
 * @apiParam {String[]} authors         List of author IDs.
 * @apiParam {String[]} contributors    List of contributor IDs.
 *
 * @apiParam {String} name              Publication title 
 * @apiParam {String} desc              Publication desc (short summary)
 * @apiParam {String} readme            Publication detail (paper abstract)
 * @apiParam {String[]} tags            Publication tags
 *
 * @apiParam {Boolean} removed          If this is a removed publication
 *
 * @apiHeader {String} authorization 
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         Updated Publication
 */
router.put('/:id', jwt({secret: config.express.pubkey}), (req, res, next)=>{
    var id = req.params.id;
    db.Publications.findById(id, (err, pub)=>{
        if(err) return next(err);
        if(!pub) return res.status(404).end();
        
        can_publish(req, pub.project, (err, can)=>{
            if(err) return next(err);
            if(!can) return res.status(401).end("you can't publish this project");

            //TODO - should I check to see if the user is listed as author?
            
            //apply updates
            if(req.body.license) pub.license = req.body.license;
            if(req.body.fundings) pub.fundings = req.body.fundings;
            if(req.body.authors) pub.authors = req.body.authors;
            if(req.body.contributors) pub.contributors = req.body.contributors;
            if(req.body.name) pub.name = req.body.name;
            if(req.body.desc) pub.desc = req.body.desc;
            if(req.body.readme) pub.readme = req.body.readme;
            if(req.body.tags) pub.tags = req.body.tags;
            if(req.body.removed) pub.removed = req.body.removed;
            pub.save((err, _pub)=>{
                if(err) return next(err);
                res.json(_pub); 
            });
        });
    });
});

/**
 * @apiGroup Publications
 * @api {put} /pub/:pubid/datasets 
 *                              
 * @apiDescription                      Publish datasets
 *
 * @apiParam {Object} [find]            Mongo query to subset datasets (all datasets in the project by default)
 *
 * @apiHeader {String} authorization 
 *                                      A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}                 Number of published datasets, etc..
 */
router.put('/:id/datasets', jwt({secret: config.express.pubkey}), (req, res, next)=>{
    var id = req.params.id;
    db.Publications.findById(id, (err, pub)=>{
        if(err) return next(err);
        if(!pub) return res.status(404).end();
        
        can_publish(req, pub.project, (err, can)=>{
            if(err) return next(err);
            if(!can) return res.status(401).end("you can't publish this project");

            let find = {};
            if(req.body.find) find = JSON.parse(req.body.find);

            //override to make sure user only publishes datasets from specific project
            find.project = pub.project;
            find.removed = false; //no point of publishing removed dataset right?

            db.Datasets.update(
                //query
                //{project: pub.project, datatype: req.body.datatype, datatype_tags: req.body.datatype_tags, removed: false}, 
                find,
                //update
                {$addToSet: {publications: pub._id}}, 
                {multi: true},
            (err, _res)=>{
                if(err) return next(err);
                res.json(_res);
            });
        });
    });
}); 

module.exports = router;
