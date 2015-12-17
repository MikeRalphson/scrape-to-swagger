var urlParser = require('url');
var fs = require('fs');
var async = require('async');
var request = require('request');
var cheerio = require('cheerio');
var sortObj = require('sorted-object');
var generateSchema = require('json-schema-generator');
var argv = require('yargs').argv;
var config = require(argv.config);

var swagger = {swagger: '2.0', paths: {}, info: {}, host: config.host, basePath: config.basePath};

var parsed = urlParser.parse(config.url);
var host = parsed.protocol + '//' + parsed.host;

function scrapePage(url, depth, callback) {
  url = urlParser.resolve(host, url);
  if (url.indexOf('mailto:') === 0) return callback();
  request.get(url, function(err, resp, body) {
    if (err) return callback(err);
    var $ = cheerio.load(body);
    addPageToSwagger($);
    if (!depth) return callback();
    var links = $('a[href]');
    async.parallel($('a[href]').map(function(i, el) {
      return function(acb) {
        scrapePage($(el).attr('href'), depth - 1, acb);
      }
    }), function(err) {
      callback(err);
    })
  })
}

function addPageToSwagger($) {
  $(config.operation.selector).each(function() {
    var op = $(this);
    var method = extractText(op, config.method);
    var path = extractText(op, config.path);
    if (!method || !path) return;
    path = urlParser.parse(path).pathname;
    pathPieces = path.split('/');
    (config.pathParameters || []).forEach(function(pathParam) {
      pathPieces = pathPieces.map(function(piece) {
        return piece.replace(pathParam.regex, '{' + pathParam.name + '}');
      });
    })
    path = pathPieces.join('/');
    method = method.toLowerCase();
    var sPath = swagger.paths[path] = swagger.paths[path] || {};
    var sOp = sPath[method] = sPath[method] || {parameters: [], responses: {}};
    var parameters = op.find(config.parameters.selector).find(config.parameter.selector);
    parameters = $(parameters);
    if (parameters) parameters.each(function() {
      var param = $(this);
      var name = extractText(param, config.parameterName);
      if (!name) return;
      var sParameter = {name: name};
      sOp.parameters.push(sParameter);
      var description = extractText(param, config.parameterDescription);
      if (description) sParameter.description = description.trim();
      sParameter.in = extractText(param, config.parameterIn) || 'query';
      sParameter.type = extractText(param, config.parameterType) || 'string';
    });
    var responses = config.responses ? op.find(config.responses.selector) : op;
    var response = config.response ? responses.find(config.response.selector) : responses;
    var responseStatus = extractText(response, config.responseStatus);
    var responseDescription = extractText(response, config.responseDescription);
    var responseSchema = extractText(response, config.responseSchema);
    try {
      responseSchema = JSON.parse(responseSchema);
    } catch (e) {
      responseSchema = undefined;
    }
    if (responseSchema && config.responseSchema.isExample) responseSchema = generateSchema(responseSchema);
    if (responseStatus) {
      responseStatus = parseInt(responseStatus);
      sResp = sOp.responses[responseStatus] = {
          description: responseDescription || '',
          schema: responseSchema || undefined,
      };
    }
  })
}

function extractText(el, extractor) {
  if (!extractor) return '';
  var text = el.find(extractor.selector).text();
  if (extractor.regex) {
    var matches = text.match(extractor.regex);
    if (!matches) return;
    text = matches[extractor.regexMatch || 1];
  }
  return text;
}

function fixErrors() {
  for (var path in swagger.paths) {
    for (var method in swagger.paths[path]) {
      var op = swagger.paths[path][method];
      op.parameters = op.parameters.filter(function(p) {
        var firstParamWithName = op.parameters.filter(function(p2) {return p2.name === p.name})[0];
        return p === firstParamWithName;
      })
      var processedPath = path;
      while (match = /{([^}]*?)}/.exec(processedPath)) {
        var paramName = match[1];
        processedPath = processedPath.replace(match[0], paramName);
        var origParam = op.parameters.filter(function(p) {return p.name === paramName})[0];
        if (origParam) origParam.in = 'path';
        else op.parameters.push({in: 'path', name: paramName, type: 'string'})
      }
    }
  }
  swagger = sortObj(swagger);
  swagger.paths = sortObj(swagger.paths);
  for (var path in swagger.paths) {
    swagger.paths[path] = sortObj(swagger.paths[path]);
  }
}

scrapePage(config.url, config.depth || 1, function(err) {
  if (err) throw err;
  fixErrors();
  fs.writeFileSync(argv.output || 'swagger.json', JSON.stringify(swagger, null, 2));
});
