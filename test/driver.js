/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

/*
 * A Test Driver for PDF.js
 */

'use strict';

// Disable worker support for running test as
//   https://github.com/mozilla/pdf.js/pull/764#issuecomment-2638944
//   "firefox-bin: Fatal IO error 12 (Cannot allocate memory) on X server :1."
// PDFJS.disableWorker = true;

var appPath, browser, canvas, currentTaskIdx, manifest, stdout;
var inFlightRequests = 0;

function queryParams() {
  var qs = window.location.search.substring(1);
  var kvs = qs.split('&');
  var params = { };
  for (var i = 0; i < kvs.length; ++i) {
    var kv = kvs[i].split('=');
    params[unescape(kv[0])] = unescape(kv[1]);
  }
  return params;
}

function load() {
  var params = queryParams();
  browser = params.browser;
  var manifestFile = params.manifestFile;
  appPath = params.path;

  canvas = document.createElement('canvas');
  canvas.mozOpaque = true;
  stdout = document.getElementById('stdout');

  log('load...\n');

  log('Harness thinks this browser is "' + browser + '" with path "' +
      appPath + '"\n');
  log('Fetching manifest "' + manifestFile + '"... ');

  var r = new XMLHttpRequest();
  r.open('GET', manifestFile, false);
  r.onreadystatechange = function loadOnreadystatechange(e) {
    if (r.readyState == 4) {
      log('done\n');
      manifest = JSON.parse(r.responseText);
      currentTaskIdx = 0;
      nextTask();
    }
  };
  r.send(null);
}

function cleanup() {
  // Clear out all the stylesheets since a new one is created for each font.
  while (document.styleSheets.length > 0) {
    var styleSheet = document.styleSheets[0];
    while (styleSheet.cssRules.length > 0)
      styleSheet.deleteRule(0);
    var ownerNode = styleSheet.ownerNode;
    ownerNode.parentNode.removeChild(ownerNode);
  }
  var guard = document.getElementById('content-end');
  var body = document.body;
  while (body.lastChild !== guard)
    body.removeChild(body.lastChild);

  // Wipe out the link to the pdfdoc so it can be GC'ed.
  for (var i = 0; i < manifest.length; i++) {
    if (manifest[i].pdfDoc) {
      manifest[i].pdfDoc.destroy();
      delete manifest[i].pdfDoc;
    }
  }
}

function exceptionToString(e) {
  if (typeof e !== 'object')
    return String(e);
  if (!('message' in e))
    return JSON.stringify(e);
  return e.message + ('stack' in e ? ' at ' + e.stack.split('\n')[0] : '');
}

function nextTask() {
  cleanup();

  if (currentTaskIdx == manifest.length) {
    done();
    return;
  }
  var task = manifest[currentTaskIdx];
  task.round = 0;

  log('Loading file "' + task.file + '"\n');

  getPdf(task.file, function nextTaskGetPdf(data) {
    var failure;
    function continuation() {
      task.pageNum = task.firstPage || 1;
      nextPage(task, failure);
    }
    try {
      var promise = PDFJS.getDocument(data);
      promise.then(function(doc) {
        task.pdfDoc = doc;
        continuation();
      }, function(e) {
        failure = 'load PDF doc : ' + e;
        continuation();
      });
      return;
    } catch (e) {
      failure = 'load PDF doc : ' + exceptionToString(e);
    }
    continuation();
  });
}

function isLastPage(task) {
  var limit = task.pageLimit || 0;
  if (!limit || limit > task.pdfDoc.numPages)
   limit = task.pdfDoc.numPages;

  return task.pageNum > limit;
}

function canvasToDataURL() {
  return canvas.toDataURL('image/png');
}

function nextPage(task, loadError) {
  var failure = loadError || '';

  if (!task.pdfDoc) {
    sendTaskResult(canvasToDataURL(), task, failure);
    log('done' + (failure ? ' (failed !: ' + failure + ')' : '') + '\n');
    ++currentTaskIdx;
    nextTask();
    return;
  }

  if (isLastPage(task)) {
    if (++task.round < task.rounds) {
      log(' Round ' + (1 + task.round) + '\n');
      task.pageNum = 1;
    } else {
      ++currentTaskIdx;
      nextTask();
      return;
    }
  }

  if (task.skipPages && task.skipPages.indexOf(task.pageNum) >= 0) {
    log(' skipping page ' + task.pageNum + '/' + task.pdfDoc.numPages +
        '... ');
    // empty the canvas
    canvas.width = 1;
    canvas.height = 1;
    clear(canvas.getContext('2d'));

    snapshotCurrentPage(task, '');
    return;
  }

  var page = null;

  if (!failure) {
    try {
      log(' loading page ' + task.pageNum + '/' + task.pdfDoc.numPages +
          '... ');
      var ctx = canvas.getContext('2d');
      task.pdfDoc.getPage(task.pageNum).then(function(page) {
        var pdfToCssUnitsCoef = 96.0 / 72.0;
        var viewport = page.getViewport(pdfToCssUnitsCoef);
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        clear(ctx);

        // using the text layer builder that does nothing to test
        // text layer creation operations
        var textLayerBuilder = {
          beginLayout: function nullTextLayerBuilderBeginLayout() {},
          endLayout: function nullTextLayerBuilderEndLayout() {},
          appendText: function nullTextLayerBuilderAppendText(text, fontName,
                                                              fontSize) {}
        };
        var renderContext = {
          canvasContext: ctx,
          textLayer: textLayerBuilder,
          viewport: viewport
        };
        var completeRender = (function(error) {
          page.destroy();
          snapshotCurrentPage(task, error);
        });
        page.render(renderContext).then(function() {
          completeRender(false);
        },
        function(error) {
          completeRender('render : ' + error);
        });
      },
      function(error) {
        snapshotCurrentPage(task, 'render : ' + error);
      });
    } catch (e) {
      failure = 'page setup : ' + exceptionToString(e);
      snapshotCurrentPage(task, failure);
    }
  }
}

function snapshotCurrentPage(task, failure) {
  log('done, snapshotting... ');

  sendTaskResult(canvasToDataURL(), task, failure);
  log('done' + (failure ? ' (failed !: ' + failure + ')' : '') + '\n');

  // Set up the next request
  var backoff = (inFlightRequests > 0) ? inFlightRequests * 10 : 0;
  setTimeout(
    function snapshotCurrentPageSetTimeout() {
      ++task.pageNum;
      nextPage(task);
    },
    backoff
  );
}

function sendQuitRequest() {
  var r = new XMLHttpRequest();
  r.open('POST', '/tellMeToQuit?path=' + escape(appPath), false);
  r.send(null);
}

function quitApp() {
  log('Done !');
  document.body.innerHTML = 'Tests are finished. <h1>CLOSE ME!</h1>' +
                             document.body.innerHTML;
  if (window.SpecialPowers) {
    SpecialPowers.quitApplication();
  } else {
    sendQuitRequest();
    window.close();
  }
}

function done() {
  if (inFlightRequests > 0) {
    document.getElementById('inFlightCount').innerHTML = inFlightRequests;
    setTimeout(done, 100);
  } else {
    setTimeout(quitApp, 100);
  }
}

function sendTaskResult(snapshot, task, failure, result) {
  // Optional result argument is for retrying XHR requests - see below
  if (!result) {
    result = JSON.stringify({
      browser: browser,
      id: task.id,
      numPages: task.pdfDoc ?
               (task.pageLimit || task.pdfDoc.numPages) : 0,
      failure: failure,
      file: task.file,
      round: task.round,
      page: task.pageNum,
      snapshot: snapshot
    });
  }

  var r = new XMLHttpRequest();
  // (The POST URI is ignored atm.)
  r.open('POST', '/submit_task_results', true);
  r.setRequestHeader('Content-Type', 'application/json');
  r.onreadystatechange = function sendTaskResultOnreadystatechange(e) {
    if (r.readyState == 4) {
      inFlightRequests--;
      // Retry until successful
      if (r.status !== 200)
        sendTaskResult(null, null, null, result);
    }
  };
  document.getElementById('inFlightCount').innerHTML = inFlightRequests++;
  r.send(result);
}

function clear(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/* Auto-scroll if the scrollbar is near the bottom, otherwise do nothing. */
function checkScrolling() {
  if ((stdout.scrollHeight - stdout.scrollTop) <= stdout.offsetHeight) {
    stdout.scrollTop = stdout.scrollHeight;
  }
}

function log(str) {
  if (stdout.insertAdjacentHTML)
    stdout.insertAdjacentHTML('BeforeEnd', str);
  else
    stdout.innerHTML += str;

  if (str.lastIndexOf('\n') >= 0)
    checkScrolling();
}
