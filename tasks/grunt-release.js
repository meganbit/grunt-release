/*
 * grunt-release
 * https://github.com/geddski/grunt-release
 *
 * Copyright (c) 2013 Dave Geddes
 * Licensed under the MIT license.
 */
'use strict';

var shell = require('shelljs');
var semver = require('semver');
var request = require('superagent');
var Q = require('q');

module.exports = function(grunt){
  grunt.registerTask('release', 'Bump version, git tag, git push, npm publish', function(type){

    function setup(file, type){
      var pkg = grunt.file.readJSON(file);
      var newVersion = pkg.version;
      var files;

      if (options.bump) {
        if (semver.valid(type)) {
          newVersion = type;
        } else {
          newVersion = semver.inc(pkg.version, type || 'patch');
        }
      }

      // Check if options.additionalFiles is a single file
      if (typeof options.additionalFiles === 'string') {
        files = options.additionalFiles.split(',').map(function (value) {
          return value.trim();
        });

        // You can also add a string with multiple files separated by `,`
        options.additionalFiles = [].concat(files);
      }

      options.additionalFiles.push(file);

      return {
        files: options.additionalFiles,
        newVersion: newVersion,
        pkg: pkg
      };
    }

    // Defaults
    var options = grunt.util._.extend({
      bump: true,
      changelog: false, // Update changelog file

      // Text which is inserted into change log
      changelogText: '### <%= version %> - <%= grunt.template.today("yyyy-mm-dd") %>\n',

      // file is in charge of master information, ie, it is it which define the base version to work on
      file: grunt.config('pkgFile') || 'package.json',

      // additionalFiles are additional files that also need to be bumped
      additionalFiles: [],
      add: true,
      commit: true,
      tag: true,
      push: true,
      pushTags: true,
      npm: true,
      remote: 'origin',
      beforeReleaseTasks: [],
      afterReleaseTasks: [],
      beforeBumpTasks: [],
      afterBumpTasks: []
    }, (grunt.config.data[this.name] || {}).options);
    var config = setup(options.file, type);

    var templateOptions = {
      data: {
        name: config.name || '',
        version: config.newVersion
      }
    };
    var tagName = grunt.template.process(grunt.config.getRaw(this.name + '.options.tagName') || '<%= version %>', templateOptions);
    var commitMessage = grunt.template.process(grunt.config.getRaw(this.name + '.options.commitMessage') || 'release <%= version %>', templateOptions);
    var tagMessage = grunt.template.process(grunt.config.getRaw(this.name + '.options.tagMessage') || 'version <%= version %>', templateOptions);

    var nowrite = grunt.option('no-write');
    var indentation = grunt.option('indentation') || '  ';
    var done = this.async();

    if (!config.newVersion) {
      grunt.warn('Resulting version number is empty.');
    }

    if (nowrite){
      grunt.log.ok('Release dry run.');
    }

    function getNpmTag(){
      var tag = grunt.option('npmtag') || options.npmtag;
      if(tag === true) {
        tag = config.newVersion;
      }

      return tag;
    }

    function ifEnabled(option, fn){
      if (options[option]) {
        return fn;
      }
    }

    function run(cmd, msg){
      var deferred = Q.defer();
      grunt.verbose.writeln('Running: ' + cmd);

      if (nowrite) {
        grunt.log.ok(msg || cmd);
        deferred.resolve();
      }
      else {
        var success = shell.exec(cmd, {silent:true}).code === 0;

        if (success){
          grunt.log.ok(msg || cmd);
          deferred.resolve();
        }
        else{
          // fail and stop execution of further tasks
          deferred.reject('Failed when executing: `' + cmd + '`\n');
        }
      }
      return deferred.promise;
    }

    function changelog(){
      var filename = options.changelog;

      // Default filename
      if(options.changelog === true) {
        filename = 'CHANGELOG.md';
      }

      config.files.push(filename);

      return Q.fcall(function () {
        var changelogText = grunt.template.process(options.changelogText, templateOptions);
        var changelogContent = changelogText + grunt.file.read(filename);

        grunt.file.write(filename, changelogContent);
        grunt.log.ok('Changelog ' + filename + ' updated');
      });
    }

    function add(){
      var files = config.files.join(' ');
      return run('git add ' + files, ' staged ' + files);
    }

    function commit(){
      if (typeof commitMessage === 'string') {
        commitMessage = [commitMessage];
      }

      var message = commitMessage.map(function(el) {
        return '-m "' + grunt.template.process(el, templateOptions) + '"';
      }).join(' ');

      return run('git commit ' + message, 'Committed all files');
    }

    function tag(){
      return run('git tag ' + tagName + ' -m "'+ tagMessage +'"', 'created new git tag: ' + tagName);
    }

    function push(){
      run('git push ' + options.remote + ' HEAD', 'pushed to remote');
    }

    function pushTags(){
      run('git push ' + options.remote + ' ' + tagName, 'pushed new tag '+ config.newVersion +' to remote');
    }

    function publish(){
      var cmd = 'npm publish';
      var msg = 'published version '+ config.newVersion +' to npm';
      var npmtag = getNpmTag();
      if (npmtag){
        cmd += ' --tag ' + npmtag;
        msg += ' with a tag of "' + npmtag + '"';
      }

      if (options.folder){ cmd += ' ' + options.folder; }
      return run(cmd, msg);
    }

    function bump(){
      var i, file, pkg, promise;
      var promises = [];
      for (i = 0; i < config.files.length; i++) {
        file = config.files[i];
        promise = (function(file){
          return Q.fcall(function () {
            pkg = grunt.file.readJSON(file);
            pkg.version = config.newVersion;
            grunt.file.write(file, JSON.stringify(pkg, null, indentation) + '\n');
            grunt.log.ok('bumped version of ' + file + ' to ' + config.newVersion);
          });
        }(file));
        promises.push(promise);
      }
      return Q.all(promises);
    }

    function githubRelease(){
      var deferred = Q.defer();

      function success(){
        grunt.log.ok('created ' + tagName + ' release on github.');
        deferred.resolve();
      }

      if (nowrite){
        success();
        return;
      }

      if (!process.env[options.github.usernameVar]) {
        grunt.log.warn('Error: No username for GitHub release');
      }

      request
        .post('https://api.github.com/repos/' + options.github.repo + '/releases')
        .auth(process.env[options.github.usernameVar], process.env[options.github.passwordVar])
        .set('Accept', 'application/vnd.github.manifold-preview')
        .set('User-Agent', 'grunt-release')
        .send({
          'tag_name': tagName,
          name: tagMessage,
          prerelease: type === 'prerelease'
        })
        .end(function(res){
          if (res.statusCode === 201){
            success();
          } else {
            deferred.reject('Error creating github release. Response: ' + res.text);
          }
        });

      return deferred.promise;
    }

    function runTasks(taskName) {
      var tasks = options[taskName];
      return Q.fcall(function () {
        if (tasks.length) {
          grunt.log.ok('running ' + taskName + ' ');
          if (!nowrite) {
            grunt.task.run(tasks);
          }
        }
      });
    }

    new Q()
      .then(ifEnabled('beforeBump', runTasks('beforeBump')))
      .then(ifEnabled('bump', bump))
      .then(ifEnabled('afterBump', runTasks('afterBump')))
      .then(ifEnabled('beforeRelease', runTasks('beforeRelease')))
      .then(ifEnabled('changelog', changelog))
      .then(ifEnabled('add', add))
      .then(ifEnabled('commit', commit))
      .then(ifEnabled('tag', tag))
      .then(ifEnabled('push', push))
      .then(ifEnabled('pushTags', pushTags))
      .then(ifEnabled('npm', publish))
      .then(ifEnabled('github', githubRelease))
      .then(ifEnabled('afterRelease', runTasks('afterRelease')))
      .catch(function(msg){
        grunt.fail.warn(msg || 'release failed');
      })
      .finally(done);

  });

};
