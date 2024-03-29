var http = require('http')
var https = require('https')

var Client = function (opts) {
  this.opts = opts || {}
  this.http = this.opts.ssl ? https : http
}

Client.prototype.call = function (method, params, callback, errback, path) {

  var time = Date.now()
  var requestJSON

  if (Array.isArray(method)) {
    // multiple rpc batch call
    requestJSON = []
    method.forEach(function (batchCall, i) {
      requestJSON.push({
        id: time + '-' + i,
        method: batchCall.method,
        params: batchCall.params
      })
    })
  } else {
    // single rpc call
    requestJSON = {
      id: time,
      method: method,
      params: params
    }
  }

  // First we encode the request into JSON
  requestJSON = JSON.stringify(requestJSON)

  // prepare request options
  var requestOptions = {
    host: this.opts.host || 'localhost',
    port: this.opts.port,
    method: 'POST',
    path: (this.opts.path ?? '') + (path ?? ''),
    headers: {
      'Host': this.opts.host || 'localhost',
      'Content-Length': requestJSON.length
    },
    agent: false,
    rejectUnauthorized: this.opts.ssl && this.opts.sslStrict !== false
  }

  if (this.opts.ssl && this.opts.sslCa) {
    requestOptions.ca = this.opts.sslCa
  }

  // use HTTP auth if user and password set
  if (this.opts.user && this.opts.pass) {
    requestOptions.auth = this.opts.user + ':' + this.opts.pass
  }

  // Now we'll make a request to the server
  var cbCalled = false

  return new Promise((resolve, reject) => {
    try {
      
      var request = this.http.request(requestOptions)

      // start request timeout timer
      var reqTimeout = setTimeout(function () {
        if (cbCalled) return
        cbCalled = true
        request.abort()
        var err = new Error('ETIMEDOUT')
        err.code = 'ETIMEDOUT'
        if (errback) errback(err)
        reject(err)
      }, this.opts.timeout || 30000)

      // set additional timeout on socket in case of remote freeze after sending headers
      request.setTimeout(this.opts.timeout || 30000, function () {
        if (cbCalled) return
        cbCalled = true
        request.abort()
        var err = new Error('ESOCKETTIMEDOUT')
        err.code = 'ESOCKETTIMEDOUT'
        if (errback) errback(err)
        reject(err)
      })

      request.on('error', function (err) {
        if (cbCalled) return
        cbCalled = true
        clearTimeout(reqTimeout)
        if (errback) errback(err)
        reject(err)
      })

      request.on('response', function (response) {
        clearTimeout(reqTimeout)

        // We need to buffer the response chunks in a nonblocking way.
        var buffer = ''
        response.on('data', function (chunk) {
          buffer = buffer + chunk
        })
        // When all the responses are finished, we decode the JSON and
        // depending on whether it's got a result or an error, we call
        // emitSuccess or emitError on the promise.
        response.on('end', function () {
          var err

          if (cbCalled) return
          cbCalled = true

          try {
            var decoded = JSON.parse(buffer)
          } catch (e) {
            if (response.statusCode !== 200) {
              err = new Error('Invalid params, response status code: ' + response.statusCode)
              err.code = -32602
              if (errback) errback(err)
              reject(err)
            } else {
              err = new Error('Problem parsing JSON response from server')
              err.code = -32603
              if (errback) errback(err)
              reject(err)
            }
            return
          }

          if (!Array.isArray(decoded)) {
            decoded = [decoded]
          }

          // iterate over each response, normally there will be just one
          // unless a batch rpc call response is being processed

          try {
              decoded.forEach(function (decodedResponse, i) {
            // for (let i = 0; i < decoded?.length; i++) {
            //   const decodedResponse = decoded[i];

              if (decodedResponse.hasOwnProperty('error') && decodedResponse.error != null) {
                err = new Error(decodedResponse.error.message || '')
                if (decodedResponse.error.code) {
                  err.code = decodedResponse.error.code
                }
                if (errback) {
                  errback(err)
                }
                reject(err)
              } else if (decodedResponse.hasOwnProperty('result')) {
                if (callback) {
                  callback(decodedResponse.result, response.headers)
                }
                resolve(decodedResponse.result, response.headers);
              } else {
                if (typeof decodedResponse !== 'string') decodedResponse = JSON.stringify(decodedResponse);
                err = new Error(decodedResponse);
                err.code = 400;
                if (errback) {
                  errback(err)
                }
                reject(err)
              }
            // }
            })
          
          } catch (err) {
            if (errback) errback(err);
            reject(err);
          }
          
        })
      })
      request.end(requestJSON)
    } catch (err) {
      if (errback) errback(err);
      reject(err);
    }
  });
}

module.exports.Client = Client
