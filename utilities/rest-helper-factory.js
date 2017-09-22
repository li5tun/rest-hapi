'use strict';

var Joi = require('joi');
Joi.objectId = require('joi-objectid')(Joi);
var _ = require('lodash');
var assert = require('assert');
var joiMongooseHelper = require('./joi-mongoose-helper');
var queryHelper = require('./query-helper');
var validationHelper = require("./validation-helper");
var authHelper = require('./auth-helper');
var chalk = require('chalk');
var config = require("../config");

//TODO: remove "options"?
//TODO: change model "alias" to "routeAlias" (or remove the option)

module.exports = function (logger, mongoose, server) {
  var HandlerHelper = require('./handler-helper-factory')(mongoose, server);

  var headersValidation;

  if (config.authStrategy) {
    headersValidation = Joi.object({
      'authorization': Joi.string().required()
    }).options({allowUnknown: true});
  }
  else {
    headersValidation = Joi.object().options({allowUnknown: true});
  }

  return {
    defaultHeadersValidation: headersValidation,

    /**
     * Generates the restful API endpoints for a single model.
     * @param server: A Hapi server.
     * @param model: A mongoose model.
     * @param options: options object.
     */
    generateRoutes: function (server, model, options) { //TODO: generate multiple DELETE routes at /RESOURCE and at
                                                        //TODO: /RESOURCE/{ownerId}/ASSOCIATION that take a list of Id's as a payload
      try {
        validationHelper.validateModel(model, logger);

        var collectionName = model.collectionDisplayName || model.modelName;
        var Log = logger.bind(chalk.blue(collectionName));

        options = options || {};

        if (model.routeOptions.allowRead !== false) {
          this.generateListEndpoint(server, model, options, Log);
          this.generateFindEndpoint(server, model, options, Log);
        }

        if (model.routeOptions.allowCreate !== false) {
          this.generateCreateEndpoint(server, model, options, Log);
        }

        if (model.routeOptions.allowUpdate !== false) {
          this.generateUpdateEndpoint(server, model, options, Log);
        }

        if (model.routeOptions.allowDelete !== false) {
          this.generateDeleteOneEndpoint(server, model, options, Log);
          this.generateDeleteManyEndpoint(server, model, options, Log);
        }

        if (model.routeOptions.associations) {
          for (var associationName in model.routeOptions.associations) {
            var association = model.routeOptions.associations[associationName];

            if (association.type == "MANY_MANY" || association.type == "ONE_MANY" || association.type == "_MANY") {
              if (association.allowAdd !== false) {
                this.generateAssociationAddOneEndpoint(server, model, association, options, Log);
                this.generateAssociationAddManyEndpoint(server, model, association, options, Log);
              }
              if (association.allowRemove !== false) {
                this.generateAssociationRemoveOneEndpoint(server, model, association, options, Log);
                this.generateAssociationRemoveManyEndpoint(server, model, association, options, Log);
              }

              if (association.allowRead !== false) {
                this.generateAssociationGetAllEndpoint(server, model, association, options, Log);
              }
            }
          }
        }

        if(model.routeOptions && model.routeOptions.extraEndpoints){
          for(var extraEndpointIndex in model.routeOptions.extraEndpoints){
            var extraEndpointFunction = model.routeOptions.extraEndpoints[extraEndpointIndex];

            extraEndpointFunction(server, model, options, Log);
          }
        }
      }
      catch(error) {
        logger.error("Error:", error);
        throw(error);
      }
    },

    /**
     * Creates an endpoint for GET /RESOURCE.
     * @param server: A Hapi server.
     * @param model: A mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    generateListEndpoint: function (server, model, options, Log) {
      validationHelper.validateModel(model, Log);

      var collectionName = model.collectionDisplayName || model.modelName;
      Log = Log.bind(chalk.yellow("List"));
      options = options || {};

      if (config.logRoutes) {
        Log.note("Generating List endpoint for " + collectionName);
      }

      var resourceAliasForRoute;

      if (model.routeOptions) {
        resourceAliasForRoute = model.routeOptions.alias || model.modelName;
      }
      else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateListHandler(model, options, Log);

      var queryModel = joiMongooseHelper.generateJoiListQueryModel(model, Log);

      var readModel = joiMongooseHelper.generateJoiReadModel(model, Log);

      if (!config.enableResponseValidation) {
        var label =  readModel._flags.label;
        readModel = Joi.alternatives().try(readModel, Joi.any()).label(label);
      }

      var auth = false;

      if (config.authStrategy && model.routeOptions.readAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(model, 'read', Log);

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for GET/" + resourceAliasForRoute + ":", scope);
          }
        }
      }
      else {
        headersValidation = null;
      }


      server.route({
        method: 'GET',
        path: '/' + resourceAliasForRoute,
        config: {
          handler: handler,
          auth: auth,
          description: 'Get a list of ' + collectionName + 's',
          tags: ['api', collectionName],
          cors: config.cors,
          validate: {
            query: queryModel,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The resource(s) was/were found successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            schema: Joi.alternatives().try(
                Joi.object({ docs: Joi.array().items(readModel).label(collectionName + "ArrayModel"), pages: Joi.any(),
                  items: Joi.any() }), Joi.number()).label(collectionName + "ListModel")
          }
        }
      });
    },

    /**
     * Creates an endpoint for GET /RESOURCE/{_id}
     * @param server: A Hapi server.
     * @param model: A mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    generateFindEndpoint: function (server, model, options, Log) {
      validationHelper.validateModel(model, Log);

      var collectionName = model.collectionDisplayName || model.modelName;
      Log = Log.bind(chalk.yellow("Find"));
      if (config.logRoutes) {
        Log.note("Generating Find endpoint for " + collectionName);
      }

      var resourceAliasForRoute;

      if (model.routeOptions) {
        resourceAliasForRoute = model.routeOptions.alias || model.modelName;
      }
      else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateFindHandler(model, options, Log);

      var queryValidation = {};

      var readableFields = queryHelper.getReadableFields(model, Log);

      if (readableFields) {
        queryValidation.$select = Joi.alternatives().try(Joi.array().items(Joi.string().valid(readableFields))
            .description('A list of basic fields to be included in each resource. Valid values include: ' + readableFields.toString().replace(/,/g,', ')), Joi.string().valid(readableFields));
      }

      var associations = model.routeOptions ? model.routeOptions.associations : null;
      if (associations) {
        queryValidation.$embed = Joi.alternatives().try(Joi.array().items(Joi.string())
            .description('A set of complex object properties to populate. Valid first level values include ' + Object.keys(associations).toString().replace(/,/g,', ')), Joi.string());
        queryValidation.$flatten = Joi.boolean()
            .description('Set to true to flatten embedded arrays, i.e. remove linking-model data.');
      }

      var readModel = model.readModel || joiMongooseHelper.generateJoiReadModel(model, Log);

      if (!config.enableResponseValidation) {
        var label =  readModel._flags.label;
        readModel = Joi.alternatives().try(readModel, Joi.any()).label(label);
      }

      var auth = false;

      if (config.authStrategy && model.routeOptions.readAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(model, 'read', Log);

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for GET/" + resourceAliasForRoute + '/{_id}' + ":", scope);
          }
        }

      }
      else {
        headersValidation = null;
      }

      server.route({
        method: 'GET',
        path: '/' + resourceAliasForRoute + '/{_id}',
        config: {
          handler: handler,
          auth: auth,
          description: 'Get a specific ' + collectionName,
          tags: ['api', collectionName],
          cors: config.cors,
          validate: {
            query: config.enableQueryValidation ? queryValidation : Joi.any(),
            params: {
              _id: Joi.objectId().required()
            },
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The resource(s) was/were found successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            schema: readModel
          }
        }
      });
    },

    /**
     * Creates an endpoint for POST /RESOURCE
     * @param server: A Hapi server.
     * @param model: A mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    generateCreateEndpoint: function (server, model, options, Log) {
      validationHelper.validateModel(model, Log);

      var collectionName = model.collectionDisplayName || model.modelName;
      Log = Log.bind(chalk.yellow("Create"));
      if (config.logRoutes) {
        Log.note("Generating Create endpoint for " + collectionName);
      }

      options = options || {};

      var resourceAliasForRoute;

      if (model.routeOptions) {
        resourceAliasForRoute = model.routeOptions.alias || model.modelName;
      }
      else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateCreateHandler(model, options, Log);

      var createModel = joiMongooseHelper.generateJoiCreateModel(model, Log);

      if (!config.enablePayloadValidation) {
        var label =  createModel._flags.label;
        createModel = Joi.alternatives().try(createModel, Joi.any()).label(label);
      }

      //EXPL: support bulk creates
      createModel = Joi.alternatives().try(Joi.array().items(createModel), createModel);

      var readModel = joiMongooseHelper.generateJoiReadModel(model, Log);
      var label =  readModel._flags.label;

      readModel = Joi.alternatives().try(Joi.array().items(readModel), readModel).label(label);

      if (!config.enableResponseValidation) {
        readModel = Joi.alternatives().try(readModel, Joi.any()).label(label);
      }

      var auth = false;

      if (config.authStrategy && model.routeOptions.createAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(model, 'create', Log);

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for POST/" + resourceAliasForRoute + ":", scope);
          }
        }
      }
      else {
        headersValidation = null;
      }

      server.route({
        method: 'POST',
        path: '/' + resourceAliasForRoute,
        config: {
          handler: handler,
          auth: auth,
          cors: config.cors,
          description: 'Create one or more new ' + collectionName + 's',
          tags: ['api', collectionName],
          validate: {
            payload: createModel,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 201, message: 'The resource was created successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            schema: readModel
          }
        }
      });
    },

    /**
     * Creates an endpoint for DELETE /RESOURCE/{_id}
     * @param server: A Hapi server.
     * @param model: A mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    generateDeleteOneEndpoint: function (server, model, options, Log) {
      validationHelper.validateModel(model, Log);

      var collectionName = model.collectionDisplayName || model.modelName;
      Log = Log.bind(chalk.yellow("DeleteOne"));
      if (config.logRoutes) {
        Log.note("Generating Delete One endpoint for " + collectionName);
      }

      options = options || {};

      var resourceAliasForRoute;

      if (model.routeOptions) {
        resourceAliasForRoute = model.routeOptions.alias || model.modelName;
      }
      else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateDeleteHandler(model, options, Log);

      var payloadModel = null;
      if (config.enableSoftDelete) {
        payloadModel = Joi.object({ hardDelete: Joi.bool() }).allow(null);

        if (!config.enablePayloadValidation) {
          payloadModel = Joi.alternatives().try(payloadModel, Joi.any());
        }
      }

      var auth = false;

      if (config.authStrategy && model.routeOptions.deleteAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(model, 'delete', Log);

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for DELETE/" + resourceAliasForRoute + "/{_id}" + ":", scope);
          }
        }
      }
      else {
        headersValidation = null;
      }

      server.route({
        method: 'DELETE',
        path: '/' + resourceAliasForRoute + "/{_id}",
        config: {
          handler: handler,
          auth: auth,
          cors: config.cors,
          description: 'Delete a ' + collectionName,
          tags: ['api', collectionName],
          validate: {
            params: {
              _id: Joi.objectId().required()
            },
            payload: payloadModel,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The resource was deleted successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            //TODO: add a response schema if needed
            //schema: model.readModel ? model.readModel : Joi.object().unknown().optional()
          }
        }
      });
    },

    /**
     * Creates an endpoint for DELETE /RESOURCE/
     * @param server: A Hapi server.
     * @param model: A mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    //TODO: handle partial deletes (return list of ids that failed/were not found)
    generateDeleteManyEndpoint: function (server, model, options, Log) {
      validationHelper.validateModel(model, Log);

      var collectionName = model.collectionDisplayName || model.modelName;
      Log = Log.bind(chalk.yellow("DeleteMany"));
      if (config.logRoutes) {
        Log.note("Generating Delete Many endpoint for " + collectionName);
      }

      options = options || {};

      var resourceAliasForRoute;

      if (model.routeOptions) {
        resourceAliasForRoute = model.routeOptions.alias || model.modelName;
      }
      else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateDeleteHandler(model, options, Log);

      var payloadModel = null;
      if (config.enableSoftDelete) {
        payloadModel = Joi.alternatives().try(Joi.array().items(Joi.object({ _id: Joi.objectId(), hardDelete: Joi.bool().default(false) })), Joi.array().items(Joi.objectId()));
      }
      else {
        payloadModel = Joi.array().items(Joi.objectId());
      }

      if (!config.enablePayloadValidation) {
        payloadModel = Joi.alternatives().try(payloadModel, Joi.any());
      }


      var auth = false;

      if (config.authStrategy && model.routeOptions.deleteAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(model, 'delete', Log);

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for DELETE/" + resourceAliasForRoute + ":", scope);
          }
        }
      }
      else {
        headersValidation = null;
      }

      server.route({
        method: 'DELETE',
        path: '/' + resourceAliasForRoute,
        config: {
          handler: handler,
          auth: auth,
          cors: config.cors,
          description: 'Delete multiple ' + collectionName + 's',
          tags: ['api', collectionName],
          validate: {
            payload: payloadModel,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The resource was deleted successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            //TODO: add a response schema if needed
            //schema: model.readModel ? model.readModel : Joi.object().unknown().optional()
          }
        }
      });
    },

    /**
     * Creates an endpoint for PUT /RESOURCE/{_id}
     * @param server: A Hapi server.
     * @param model: A mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    generateUpdateEndpoint: function (server, model, options, Log) {
      validationHelper.validateModel(model, Log);

      var collectionName = model.collectionDisplayName || model.modelName;
      Log = Log.bind(chalk.yellow("Update"));
      if (config.logRoutes) {
        Log.note("Generating Update endpoint for " + collectionName);
      }

      options = options || {};

      var resourceAliasForRoute;

      if (model.routeOptions) {
        resourceAliasForRoute = model.routeOptions.alias || model.modelName;
      }
      else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateUpdateHandler(model, options, Log);

      var updateModel = joiMongooseHelper.generateJoiUpdateModel(model, Log);

      if (!config.enablePayloadValidation) {
        var label =  updateModel._flags.label;
        updateModel = Joi.alternatives().try(updateModel, Joi.any()).label(label);
      }

      var readModel = joiMongooseHelper.generateJoiReadModel(model, Log);

      if (!config.enableResponseValidation) {
        var label =  readModel._flags.label;
        readModel = Joi.alternatives().try(readModel, Joi.any()).label(label);
      }

      var auth = false;

      if (config.authStrategy && model.routeOptions.updateAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(model, 'update', Log);

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for PUT/" + resourceAliasForRoute + '/{_id}' + ":", scope);
          }
        }
      }
      else {
        headersValidation = null;
      }

      server.route({
        method: 'PUT',
        path: '/' + resourceAliasForRoute + '/{_id}',
        config: {
          handler: handler,
          auth: auth,
          cors: config.cors,
          description: 'Update a ' + collectionName,
          tags: ['api', collectionName],
          validate: {
            params: {
              _id: Joi.objectId().required()
            },
            payload: updateModel,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The resource was updated successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            schema: readModel
          }
        }
      });
    },

    /**
     * Creates an endpoint for PUT /OWNER_RESOURCE/{ownerId}/CHILD_RESOURCE/{childId}
     * @param server: A Hapi server.
     * @param ownerModel: A mongoose model.
     * @param association: An object containing the association data/child mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    generateAssociationAddOneEndpoint: function (server, ownerModel, association, options, Log) {
      validationHelper.validateModel(ownerModel, Log);

      assert(ownerModel.routeOptions.associations, "model associations must exist");
      assert(association, "association input must exist");

      var associationName = association.include.as || association.include.model.modelName;
      var ownerModelName = ownerModel.collectionDisplayName || ownerModel.modelName;
      var childModel = association.include.model;

      var childModelName = childModel.collectionDisplayName || childModel.modelName;

      Log = Log.bind(chalk.yellow("AddOne"));
      if (config.logRoutes) {
        Log.note("Generating addOne association endpoint for " + ownerModelName + " -> " + associationName);
      }

      options = options || {};

      var ownerAlias = ownerModel.routeOptions.alias || ownerModel.modelName;
      var childAlias = association.alias || association.include.model.modelName;

      var handler = HandlerHelper.generateAssociationAddOneHandler(ownerModel, association, options, Log);

      var payloadValidation = null;

      //EXPL: A payload is only relevant if a through model is defined
      if (association.include.through) {
        payloadValidation = joiMongooseHelper.generateJoiCreateModel(association.include.through, Log);

        if (!config.enablePayloadValidation) {
          var label =  payloadValidation._flags.label;
          payloadValidation = Joi.alternatives().try(payloadValidation, Joi.any()).label(label);
        }
      }

      var auth = false;

      if (config.authStrategy && ownerModel.routeOptions.associateAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(ownerModel, 'associate', Log);
        var addScope = 'add' + ownerModelName[0].toUpperCase() + ownerModelName.slice(1) + associationName[0].toUpperCase() + associationName.slice(1) + 'Scope';
        scope = scope.concat(authHelper.generateScopeForEndpoint(ownerModel, addScope, Log));

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for PUT/" + ownerAlias + '/{ownerId}/' + childAlias + "/{childId}" + ":", scope);
          }
        }
      }
      else {
        headersValidation = null;
      }

      server.route({
        method: 'PUT',
        path: '/' + ownerAlias + '/{ownerId}/' + childAlias + "/{childId}",
        config: {
          handler: handler,
          auth: auth,
          cors: config.cors,
          description: 'Add a single ' + childModelName + ' to a ' + ownerModelName + '\'s list of ' + associationName,
          tags: ['api', associationName, ownerModelName],
          validate: {
            params: {
              ownerId: Joi.objectId().required(),
              childId: Joi.objectId().required()
            },
            payload: payloadValidation,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 204, message: 'The association was added successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {}//TODO: verify what response schema is needed here
        }
      });
    },

    /**
     * Creates an endpoint for DELETE /OWNER_RESOURCE/{ownerId}/CHILD_RESOURCE/{childId}
     * @param server: A Hapi server.
     * @param ownerModel: A mongoose model.
     * @param association: An object containing the association data/child mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    generateAssociationRemoveOneEndpoint: function (server, ownerModel, association, options, Log) {
      validationHelper.validateModel(ownerModel, Log);

      assert(ownerModel.routeOptions.associations, "model associations must exist");
      assert(association, "association input must exist");

      var associationName = association.include.as || association.include.model.modelName;
      var ownerModelName = ownerModel.collectionDisplayName || ownerModel.modelName;
      var childModel = association.include.model;

      var childModelName = childModel.collectionDisplayName || childModel.modelName;

      Log = Log.bind(chalk.yellow("RemoveOne"));
      if (config.logRoutes) {
        Log.note("Generating removeOne association endpoint for " + ownerModelName + " -> " + associationName);
      }

      options = options || {};

      var ownerAlias = ownerModel.routeOptions.alias || ownerModel.modelName;
      var childAlias = association.alias || association.include.model.modelName;

      var handler = HandlerHelper.generateAssociationRemoveOneHandler(ownerModel, association, options, Log);

      var auth = false;

      if (config.authStrategy && ownerModel.routeOptions.associateAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(ownerModel, 'associate', Log);
        var removeScope = 'remove' + ownerModelName[0].toUpperCase() + ownerModelName.slice(1) + associationName[0].toUpperCase() + associationName.slice(1) + 'Scope';
        scope = scope.concat(authHelper.generateScopeForEndpoint(ownerModel, removeScope, Log));

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for DELETE/" + ownerAlias + '/{ownerId}/' + childAlias + "/{childId}" + ":", scope);
          }
        }
      }
      else {
        headersValidation = null;
      }

      server.route({
        method: 'DELETE',
        path: '/' + ownerAlias + '/{ownerId}/' + childAlias + "/{childId}",
        config: {
          handler: handler,
          auth: auth,
          cors: config.cors,
          description: 'Remove a single ' + childModelName + ' from a ' + ownerModelName + '\'s list of ' + associationName,
          tags: ['api', associationName, ownerModelName],
          validate: {
            params: {
              ownerId: Joi.objectId().required(),
              childId: Joi.objectId().required()
            },
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 204, message: 'The association was deleted successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {code: 401, message: 'The authentication header was missing/malformed, or the token has expired.'},
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {}
        }
      });
    },

    /**
     * Creates an endpoint for POST /OWNER_RESOURCE/{ownerId}/CHILD_RESOURCE
     * @param server: A Hapi server.
     * @param ownerModel: A mongoose model.
     * @param association: An object containing the association data/child mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    generateAssociationAddManyEndpoint: function (server, ownerModel, association, options, Log) {
      validationHelper.validateModel(ownerModel, Log);

      assert(ownerModel.routeOptions.associations, "model associations must exist");
      assert(association, "association input must exist");

      var associationName = association.include.as || association.include.model.modelName;
      var ownerModelName = ownerModel.collectionDisplayName || ownerModel.modelName;
      var childModel = association.include.model;

      var childModelName = childModel.collectionDisplayName || childModel.modelName;

      Log = Log.bind(chalk.yellow("AddMany"));
      if (config.logRoutes) {
        Log.note("Generating addMany association endpoint for " + ownerModelName + " -> " + associationName);
      }

      options = options || {};

      var ownerAlias = ownerModel.routeOptions.alias || ownerModel.modelName;
      var childAlias = association.alias || association.include.model.modelName;

      var handler = HandlerHelper.generateAssociationAddManyHandler(ownerModel, association, options, Log);

      var payloadValidation;
      var label = "";

      if (association.include && association.include.through) {
        payloadValidation = joiMongooseHelper.generateJoiCreateModel(association.include.through, Log);
        label =  payloadValidation._flags.label + "_many";
        payloadValidation = payloadValidation.keys({
          childId: Joi.objectId().description("the " + childModelName + "'s _id")
        }).label(label);
        payloadValidation = Joi.array().items(payloadValidation).required();
      } 
      else {
        payloadValidation = Joi.array().items(Joi.objectId()).required();
      }

      if (!config.enablePayloadValidation) {
        label =  payloadValidation._flags.label;
        payloadValidation = Joi.alternatives().try(payloadValidation, Joi.any()).label(label || "blank");
      }

      var auth = false;

      if (config.authStrategy && ownerModel.routeOptions.associateAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(ownerModel, 'associate', Log);
        var addScope = 'add' + ownerModelName[0].toUpperCase() + ownerModelName.slice(1) + associationName[0].toUpperCase() + associationName.slice(1) + 'Scope';
        scope = scope.concat(authHelper.generateScopeForEndpoint(ownerModel, addScope, Log));

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for POST/" + ownerAlias + '/{ownerId}/' + childAlias + ":", scope);
          }
        }
      }
      else {
        headersValidation = null;
      }

      server.route({
        method: 'POST',
        path: '/' + ownerAlias + '/{ownerId}/' + childAlias,
        config: {
          handler: handler,
          auth: auth,
          cors: config.cors,
          description: 'Add multiple ' + childModelName + 's to a ' + ownerModelName + '\'s list of ' + associationName,
          tags: ['api', associationName, ownerModelName],
          validate: {
            params: {
              ownerId: Joi.objectId().required()
            },
            payload: payloadValidation,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 204, message: 'The association was set successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {code: 401, message: 'The authentication header was missing/malformed, or the token has expired.'},
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {}
        }
      })
    },

    /**
     * Creates an endpoint for DELETE /OWNER_RESOURCE/{ownerId}/CHILD_RESOURCE
     * @param server: A Hapi server.
     * @param ownerModel: A mongoose model.
     * @param association: An object containing the association data/child mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    generateAssociationRemoveManyEndpoint: function (server, ownerModel, association, options, Log) {
      validationHelper.validateModel(ownerModel, Log);

      assert(ownerModel.routeOptions.associations, "model associations must exist");
      assert(association, "association input must exist");

      var associationName = association.include.as || association.include.model.modelName;
      var ownerModelName = ownerModel.collectionDisplayName || ownerModel.modelName;
      var childModel = association.include.model;

      var childModelName = childModel.collectionDisplayName || childModel.modelName;

      Log = Log.bind(chalk.yellow("RemoveMany"));
      if (config.logRoutes) {
        Log.note("Generating removeMany association endpoint for " + ownerModelName + " -> " + associationName);
      }

      options = options || {};

      var ownerAlias = ownerModel.routeOptions.alias || ownerModel.modelName;
      var childAlias = association.alias || association.include.model.modelName;

      var handler = HandlerHelper.generateAssociationRemoveManyHandler(ownerModel, association, options, Log);

      var payloadValidation = Joi.array().items(Joi.objectId()).required();

      if (!config.enablePayloadValidation) {
        payloadValidation = Joi.alternatives().try(payloadValidation, Joi.any());
      }

      var auth = false;

      if (config.authStrategy && ownerModel.routeOptions.associateAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(ownerModel, 'associate', Log);
        var removeScope = 'remove' + ownerModelName[0].toUpperCase() + ownerModelName.slice(1) + associationName[0].toUpperCase() + associationName.slice(1) + 'Scope';
        scope = scope.concat(authHelper.generateScopeForEndpoint(ownerModel, removeScope, Log));

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for DELETE/" + ownerAlias + '/{ownerId}/' + childAlias + ":", scope);
          }
        }
      }
      else {
        headersValidation = null;
      }

      server.route({
        method: 'DELETE',
        path: '/' + ownerAlias + '/{ownerId}/' + childAlias,
        config: {
          handler: handler,
          auth: auth,
          cors: config.cors,
          description: 'Remove multiple ' + childModelName + 's from a ' + ownerModelName + '\'s list of ' + associationName,
          tags: ['api', associationName, ownerModelName],
          validate: {
            params: {
              ownerId: Joi.objectId().required()
            },
            payload: payloadValidation,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 204, message: 'The association was set successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {code: 401, message: 'The authentication header was missing/malformed, or the token has expired.'},
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {}
        }
      })
    },

    /**
     * Creates an endpoint for GET /OWNER_RESOURCE/{ownerId}/CHILD_RESOURCE
     * @param server: A Hapi server.
     * @param ownerModel: A mongoose model.
     * @param association: An object containing the association data/child mongoose model.
     * @param options: Options object.
     * @param Log: A logging object.
     */
    generateAssociationGetAllEndpoint: function (server, ownerModel, association, options, Log) {
      validationHelper.validateModel(ownerModel, Log);

      assert(ownerModel.routeOptions.associations, "model associations must exist");
      assert(association, "association input must exist");

      var associationName = association.include.as || association.include.model.modelName;
      var ownerModelName = ownerModel.collectionDisplayName || ownerModel.modelName;
      
      Log = Log.bind(chalk.yellow("GetAll"));
      if (config.logRoutes) {
        Log.note("Generating list association endpoint for " + ownerModelName + " -> " + associationName);
      }
      
      options = options || {};

      var ownerAlias = ownerModel.routeOptions.alias || ownerModel.modelName;
      var childAlias = association.alias || association.include.model.modelName;

      var childModel = association.include.model;


      var handler = HandlerHelper.generateAssociationGetAllHandler(ownerModel, association, options, Log);

      var queryModel = joiMongooseHelper.generateJoiListQueryModel(childModel, Log);

      var readModel = joiMongooseHelper.generateJoiReadModel(childModel, Log);

      if (association.linkingModel) {
        var associationModel = {};
        associationModel[association.linkingModel] = joiMongooseHelper.generateJoiReadModel(association.include.through, Log);
        readModel = readModel.keys(associationModel);
      }

      readModel = readModel.label(ownerModelName + "_" + associationName + "ReadModel");

      if (!config.enableResponseValidation) {
        var label =  readModel._flags.label;
        readModel = Joi.alternatives().try(readModel, Joi.any()).label(label);
      }

      var auth = false;

      if (config.authStrategy && ownerModel.routeOptions.readAuth !== false) {
        auth = {
          strategy: config.authStrategy
        };

        var scope = authHelper.generateScopeForEndpoint(ownerModel, 'read', Log);
        var getScope = 'get' + ownerModelName[0].toUpperCase() + ownerModelName.slice(1) + associationName[0].toUpperCase() + associationName.slice(1) + 'Scope';
        scope = scope.concat(authHelper.generateScopeForEndpoint(ownerModel, getScope, Log));

        if (!_.isEmpty(scope)) {
          auth.scope = scope;
          if (config.logScopes) {
            Log.debug("Scope for GET/" + ownerAlias + '/{ownerId}/' + childAlias + ":", scope);
          }
        }
      }
      else {
        headersValidation = null;
      }

      server.route({
        method: 'GET',
        path: '/' + ownerAlias + '/{ownerId}/' + childAlias,
        config: {
          handler: handler,
          auth: auth,
          cors: config.cors,
          description: 'Get all of the ' + associationName + ' for a ' + ownerModelName,
          tags: ['api', associationName, ownerModelName],
          validate: {
            query: queryModel,
            params: {
              ownerId: Joi.objectId().required()
            },
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The association was set successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {code: 401, message: 'The authentication header was missing/malformed, or the token has expired.'},
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            schema: Joi.alternatives().try(
                Joi.object({ docs: Joi.array().items(readModel).label(ownerModelName + "_" + associationName + "ArrayModel"), pages: Joi.any(), items: Joi.any() }),
                Joi.number()).label(ownerModelName + "_" + associationName + "ListModel")
          }
        }
      });
    }
  }
};
