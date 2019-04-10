const crypto = require("crypto")
const uuidv4 = require("uuid/v4")
const request = require("request-promise-native")
const IPFS = require("ipfs-http-client")
const Sequelize = require("sequelize")
const elasticsearch = require("elasticsearch")

const { Buffer } = IPFS

const assemble = require("./assemble")

const {
	DocumentIdKey,
	OriginalFilenameKey,
	MetaRequest,
	TextRequest,
	IpfsOptions,
	IpldOptions,
} = require("./constants")

const { NODE_ENV, IPFS_HOST, DATABASE_URL, ELASTIC_URL } = process.env
const s3Bucket = NODE_ENV === "development" ? "dev-assets" : "assets"

const ipfs = IPFS({ host: IPFS_HOST, port: 443, protocol: "https" })

const sequelize = new Sequelize(DATABASE_URL, {
	logging: false,
	dialectOptions: { ssl: true },
})

var elastic = new elasticsearch.Client({ host: ELASTIC_URL })

const Document = sequelize.import("./models/Documents.js")
const Assertion = sequelize.import("./models/Assertions.js")

const getFileUrl = path => `https://${s3Bucket}.priorartarchive.org/${path}`

ipfs
	.id()
	.then(id => console.log("connected to IPFS node with id", id))
	.catch(err => {
		console.error("Failed to connect to IPFS node", err)
		process.exit(1)
	})

module.exports = async function(eventTime, Bucket, Key, data) {
	const { Body, ContentLength, ContentType, Metadata } = data
	const {
		[DocumentIdKey]: documentId,
		[OriginalFilenameKey]: fileName,
	} = Metadata

	const [uploads, organizationId, fileId] = Key.split("/")
	const fileUrl = getFileUrl(Key)

	// These are default properties for the Document in case we have to create one
	const defaults = {
		id: documentId,
		organizationId,
		fileUrl,
		contentType: ContentType,
	}

	const formData = { [fileName]: Body }

	// we need to add the uploaded file to IPFS
	const [{ hash: fileHash }] = await ipfs.add(Buffer.from(Body), IpfsOptions)

	const previous = await Assertion.findOne({
		where: { organizationId, fileCid: fileHash },
	})

	// If the there's already an assertion with the same file hash and organization ID,
	// just return the documentId and cid of that assertion right away.
	if (previous !== null) {
		const { documentId, cid } = previous
		return { documentId, cid }
	}

	// Now we have a bunch of stuff to do all at once!

	// The original file and extracted text are added to IPFS as regular files (bytes).
	// The metadata is added to *IPLD* as cbor-encoded JSON. This is more compact but also
	// lets us address paths into the JSON object when we talk about provenance (!!!).

	// `meta` is the actual JSON metadata object parsed from Tika;
	// we return it from a second Promise.all. There's a `cid` intermediate
	// value (an instance of Cid with a `toString()` method) that we subsequently
	// pin to IPFS (bizarrely, dag.put() doesn't have a {pin: true} option, unlike .add()).
	// The result we get from ipfs.pin.add is the same shape as the results we get from
	// ipfs.add - an array of objects with a string `hash` property [{hash: string}].
	const startTime = new Date() // prov:generatedAtTime for the metadata and transcript
	const [
		[document, created],
		[text, [{ hash: textHash, size: textSize }]],
		[meta, [{ hash: metaHash }]],
	] = await Promise.all([
		// we need to create a new document, or get the existing one.
		Document.findOrCreate({ where: { id: documentId }, defaults }),
		// we need to post the file to Tika's text extraction service, and add the result to IPFS
		request
			.post({ formData, ...TextRequest })
			.then(text =>
				Promise.all([text, ipfs.add(Buffer.from(text), IpfsOptions)])
			),
		// we also need to post the file to Tika's metadata service, and add the result to IPFS
		request
			.post({ formData, ...MetaRequest })
			.then(body => JSON.parse(body))
			.then(meta => Promise.all([meta, ipfs.dag.put(meta, IpldOptions)]))
			.then(([meta, cid]) => Promise.all([meta, ipfs.pin.add(cid.toString())])),
	])

	const dateString =
		meta.PushDate || meta.Date || meta.UploadDate || meta.created

	const title = meta.title || document.title

	const generatedAtTime = startTime.toISOString()
	const elasticIndex = {
		title,
		text,
		fileUrl,
		organizationId,
		uploadDate: generatedAtTime,
		contentLength: ContentLength,
		contentType: ContentType,
	}

	if (Date.parse(dateString)) {
		const date = new Date(dateString)
		elasticIndex.publicationDate = date.toISOString()
	}

	if (meta.hasOwnProperty("language")) {
		elasticIndex.language = meta["langauge"]
	}

	const assertionPayload = {
		eventTime,
		documentId,
		contentLength: ContentLength,
		contentType: ContentType,
		generatedAtTime,
		fileUrl,
		fileName,
		fileHash,
		textHash,
		textSize: textSize + "B",
		metadata: meta,
		metadataHash: metaHash,
	}

	const [{ cid }] = await Promise.all([
		assemble(assertionPayload)
			.then(canonized => ipfs.add(Buffer.from(canonized)))
			.then(([{ hash: cid }]) =>
				Assertion.create({
					id: uuidv4(),
					documentId,
					organizationId,
					cid,
					fileCid: fileHash,
					textCid: textHash,
				})
			),
		document.update({ title, fileUrl, fileName, contentType: ContentType }),
		elastic.index({
			index: "documents",
			type: "doc",
			id: documentId,
			body: elasticIndex,
		}),
	])

	return { documentId, cid }
}
